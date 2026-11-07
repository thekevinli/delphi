import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Highlight, Note } from "../../app/lib/api";

// The frame scripts come from the backend this app pins and bundles: the
// installed wheel under .delphi-build/python, produced by `npm run build`.
import { readdirSync } from "node:fs";
const sitePackages = (() => {
  const lib = new URL("../../../.delphi-build/python/lib/", import.meta.url);
  const python = readdirSync(lib).find(name => /^python3\.\d+$/.test(name));
  if (!python) throw new Error("No bundled backend; run npm run build first.");
  return new URL(`${python}/site-packages/delphi_core/`, lib);
})();
const backendFile = (file: string) => readFileSync(new URL(file, sitePackages), "utf8");
const bridge = backendFile("web_bridge.js").replace("/* ANNOTATION_IMPLEMENTATION */", backendFile("web_annotation_bridge.js"));
const worker = ["web_annotations.js", "web_annotation_worker.js"].map(backendFile).join("\n");
// Page copies need a bridge that can serialise the page; the pinned backend's
// may predate that, and then the tests of it wait for the pin to move.
const pageCopies = bridge.includes('"page-capture"');
// A page that is a wrapper around an embedded frame needs a bridge that can say
// so, and that reports a click landing in that frame.
const needsEmbeds = () => test.skip(!bridge.includes('"focus-entered"'), "The pinned backend's bridge predates embedded pages; move build/backend-release.env.");
const needsPageCopies = () => test.skip(!pageCopies, "The pinned backend's bridge predates page copies; move build/backend-release.env.");
const article = `<!doctype html><html><head><meta charset="utf-8"><title>Test article</title><style>body{font:18px/1.8 Georgia;margin:36px}p{max-width:650px}</style></head><body><article><h1>Test article</h1><p id="passage">An exact <b>important</b> passage with 😀 evidence.</p><p>Another paragraph keeps the article readable and lets us verify that its source text remains unchanged when highlighted. The reader owns the notes, and the article never sees their contents.</p><p id="second">A second independently annotated passage.</p><div style="height:1400px"></div><p>End of article.</p></article><script>${bridge}</script></body></html>`;

async function setup(page: Page, scaled = false, rendered = false, query = "") {
  const state = { highlights: [] as Highlight[], notes: [] as Note[], failSave: false, failHighlight: false, dropHighlightResponse: false, copy: { html: article }, sourceHtml: article, pageLoads: [] as string[], supportsViews: true, refreshes: 0, savedAt: "2026-09-22T12:00:00Z", unavailable: [] as string[], unavailableReason: "", holdSave: null as Promise<void> | null, saving: false,
    // What `PUT saved-page` was sent, and how this fake backend answers it.
    uploads: [] as { html: string; width: number; url: string }[], refusePage: false, pageRoute: true, holdHighlight: null as Promise<void> | null, highlightPosts: 0, olderBridge: false, refuseRefresh: false };
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname.endsWith("annotation-worker.js")) return route.fulfill({ contentType: "application/javascript", body: worker });
    if (url.pathname.endsWith("page-url")) {
      const view = url.searchParams.get("view");
      return json({ url: `/api/projects/project/papers/paper/page?view=${view}`, view: state.supportsViews ? view : undefined, sandbox: "allow-scripts", allow: "", renderWidth: scaled ? 1512 : null });
    }
    if (url.pathname.endsWith("/refresh")) {
      // The text the model reads; the page copy is not the refresh's to touch.
      state.refreshes++;
      if (state.refuseRefresh) return json({ detail: { code: "blocked", message: "www.pi.website blocks automated readers." } }, 403);
      return json({ id: "paper" });
    }
    if (url.pathname.endsWith("/saved-page")) {
      if (!state.pageRoute) return json({ detail: "Not Found" }, 404);
      if (req.method() !== "PUT" || req.headers()["content-type"] !== "text/html; charset=utf-8") return json({ detail: "Bad page copy" }, 400);
      if (state.refusePage) return json({ detail: "The page no longer holds the document's text, so the saved copy was kept." }, 409);
      state.uploads.push({ html: req.postData() ?? "", width: Number(url.searchParams.get("width")), url: url.searchParams.get("url") ?? "" });
      state.savedAt = "2026-09-22T13:00:00Z";
      // As the backend frames it: the page copy, with a bridge of its own.
      state.copy = { html: (req.postData() ?? "").replace("</body>", `<script>${bridge}</script></body>`) };
      return json({ changed: true, savedAt: state.savedAt });
    }
    if (url.pathname.endsWith("/page")) {
      const view = url.searchParams.get("view") ?? "live";
      state.pageLoads.push(view);
      // What the backend frames for a view it could not serve.
      if (state.unavailable.includes(view)) return route.fulfill({ status: view === "live" ? 503 : 404, contentType: "text/html", body: `<!doctype html><html data-delphi-unavailable="${view}"${state.unavailableReason ? ` data-delphi-unavailable-reason="${state.unavailableReason}"` : ""}><head></head><body><p>Unavailable</p><script>${bridge}</script></body></html>` });
      // Framed as `render_frame` frames it, at the document's own address.
      const framed = (view === "cached" ? state.copy.html : state.sourceHtml).replace("<head>", '<head><base href="https://article.example/read" data-delphi-frame="">');
      // A bridge from a backend before page copies never says it can make one.
      const html = state.olderBridge ? framed.replace(/pageCapture: true,/, "") : framed;
      return route.fulfill({ contentType: "text/html", body: scaled ? html.replace("<html>", '<html data-delphi-render-width="1512">') : html });
    }
    if (url.pathname.endsWith("annotation-revision")) {
      return json({ available: rendered || !!state.copy, savedAt: state.savedAt });
    }
    if (url.pathname.endsWith("annotation-placements")) return route.fulfill({ status: 204 });
    if (url.pathname.endsWith("/highlights")) {
      if (req.method() === "GET") return json(state.highlights);
      if (state.failHighlight) return json({ detail: "Highlight offline" }, 503);
      state.highlightPosts++;
      if (state.holdHighlight) await state.holdHighlight;
      const data = req.postDataJSON();
      const saved = state.highlights.find(h => h.requestId === data.requestId) ?? { ...data, id: `h${state.highlights.length + 1}` };
      if (!state.highlights.includes(saved)) state.highlights.push(saved);
      if (state.dropHighlightResponse) { state.dropHighlightResponse = false; return route.abort(); }
      return json(saved, 201);
    }
    if (url.pathname.includes("/highlights/")) {
      const id = url.pathname.split("/").at(-1)!;
      state.highlights = state.highlights.filter(h => h.id !== id); state.notes = state.notes.filter(n => n.highlightId !== id);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/notes")) {
      if (req.method() === "GET") return json(state.notes);
      if (state.failSave) return json({ detail: "Note offline" }, 503);
      const body = req.postDataJSON();
      state.saving = true;
      if (state.holdSave) await state.holdSave;
      const saved = { ...body, id: "n1", createdAt: "now", updatedAt: "now", filedAt: null };
      state.notes = [...state.notes.filter(n => n.highlightId !== saved.highlightId), saved]; return json(saved);
    }
    return json({ detail: `Unexpected test request ${url.pathname}` }, 404);
  });
  await page.goto(`/tests/browser/harness.html${query}`);
  await expect(page.locator("iframe")).toBeVisible();
  return state;
}
async function select(page: Page, id = "passage") {
  const frame = page.frameLocator("iframe");
  await frame.locator(`#${id}`).evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await expect(page.getByRole("button", { name: "Highlight", exact: true })).toBeEnabled();
}
async function paintCount(page: Page) {
  return page.frameLocator("iframe").locator("body").evaluate(() => CSS.highlights.get("delphi-annotations")?.size ?? 0);
}

test("a drag that pauses, then Highlight at once, saves the passage the reader released on", async ({ page }) => {
  const state = await setup(page);
  const frameBox = (await page.locator("iframe").boundingBox())!;
  // Two full lines selected, then the drag carries on along the second: the
  // menu's anchor does not move, so a quick click lands on the menu the pause
  // opened. It must still take the passage as released.
  const lines = await page.frameLocator("iframe").locator("p:not([id])").first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, y: r.top + r.height / 2 }));
  });
  const [first, second] = lines;
  await page.mouse.move(frameBox.x + first.left + 1, frameBox.y + first.y);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + second.left + (second.right - second.left) / 3, frameBox.y + second.y, { steps: 5 });
  await expect(page.getByRole("button", { name: "Highlight", exact: true })).toBeVisible();
  await page.mouse.move(frameBox.x + second.right - 1, frameBox.y + second.y, { steps: 5 });
  await page.mouse.up();
  const released = await page.frameLocator("iframe").locator("body").evaluate(() => String(getSelection()));
  const button = (await page.getByRole("button", { name: "Highlight", exact: true }).boundingBox())!;
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect.poll(() => state.highlights.length).toBe(1);
  expect(state.highlights[0].text).toBe(released);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("canonical highlights survive retry and reload without wrapping article text", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  state.dropHighlightResponse = true;
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => state.highlights.length).toBe(1);
  expect(state.highlights[0].text).toContain("😀");
  await expect.poll(() => paintCount(page)).toBe(1);
  await expect(page.frameLocator("iframe").locator("#passage")).toHaveJSProperty("innerHTML", "An exact <b>important</b> passage with 😀 evidence.");
  await page.reload();
  await expect.poll(() => paintCount(page)).toBe(1);
});

test("note failures retain the draft, successful save paints an icon, and delete cascades", async ({ page }, testInfo) => {
  const state = await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("My durable thought");
  state.failSave = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Note offline");
  await expect(editor).toContainText("My durable thought");
  state.failSave = false;
  await editor.press("Meta+Enter");
  await expect(editor).toHaveCount(0);
  expect(state.notes[0]).toMatchObject({ page: null, anchorY: null, body: "My durable thought" });
  await expect(page.locator(".page-note-icon")).toBeVisible();
  await page.locator(".page-note-icon").hover();
  await expect(page.getByRole("tooltip")).toContainText("My durable thought");
  await expect(page.locator(".note-card-preview")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.locator(".page-note-icon").click();
  await expect(page.locator(".page-note-icon")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".note-card-preview")).toContainText("My durable thought");
  await page.screenshot({ path: testInfo.outputPath("note-preview.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await expect.poll(() => state.highlights.length).toBe(0);
  expect(state.notes).toHaveLength(0);
});

test("the first annotation of a visit refreshes the saved copy once", async ({ page }) => {
  const state = await setup(page);
  // Opening, reading and reloading never refresh anything.
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForTimeout(1500);
  expect(state.refreshes).toBe(0);
  await select(page);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => state.refreshes).toBe(1);
  // More annotations in the same visit mark up the same page: no second refresh.
  await select(page, "second");
  await page.getByRole("button", { name: "Note", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("A second thought");
  await editor.press("Enter");
  await expect.poll(() => state.notes.length).toBe(1);
  await page.waitForTimeout(1500);
  expect(state.refreshes).toBe(1);
  // A new visit is a new version to keep: the page has grown a passage since.
  state.sourceHtml = article.replace('<p id="second">', '<p id="third">A passage added since the last visit.</p><p id="second">');
  await page.reload();
  await expect(page.locator("iframe")).toBeVisible();
  await select(page, "third");
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => state.refreshes).toBe(2);
});

test("annotating the saved copy never refreshes it", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("More", { exact: true }).click();
  await page.getByRole("button", { name: /View cached/ }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=cached/);
  await select(page);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => state.highlights.length).toBe(1);
  await page.waitForTimeout(1500);
  expect(state.refreshes).toBe(0);
  expect(state.uploads).toHaveLength(0);
});

async function highlight(page: Page, id: string) {
  await select(page, id);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
}

test("the first annotation of a visit keeps the page as drawn, and the rest of the visit keeps nothing more", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  // Opening and reloading keep nothing.
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForTimeout(1000);
  expect(state.uploads).toHaveLength(0);
  // A page script taking the base away leaves the frame's own URL — Delphi's,
  // with its token — as the page's; the copy still names the site.
  await page.frameLocator("iframe").locator("base").evaluate(node => node.remove());
  await highlight(page, "passage");
  await expect.poll(() => state.uploads.length).toBe(1);
  const [kept] = state.uploads;
  const width = await page.frameLocator("iframe").locator("body").evaluate(() => innerWidth);
  expect(kept).toMatchObject({ width, url: "https://article.example/read" });
  // The page's, not Delphi's: no bridge, no highlight style, no marker attributes.
  expect(kept.html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(kept.html).not.toMatch(/<script|data-delphi|::highlight/);
  expect(kept.html).toContain("An exact <b>important</b> passage");
  // Another mark, a note, and a mark on text the page has added since.
  await highlight(page, "second");
  await expect.poll(() => state.highlights.length).toBe(2);
  await page.frameLocator("iframe").locator("#second").click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("A thought");
  await page.locator('[contenteditable="true"]').press("Enter");
  await expect.poll(() => state.notes.length).toBe(1);
  await page.frameLocator("iframe").locator("#second").evaluate(node => node.insertAdjacentHTML("afterend", '<p id="reply">A reply added below the article.</p>'));
  await highlight(page, "reply");
  await expect.poll(() => state.highlights.length).toBe(3);
  await page.waitForTimeout(1000);
  expect(state.uploads).toHaveLength(1);
  expect(state.refreshes).toBe(1);
  // A new visit keeps the page as it is then.
  state.sourceHtml = article.replace('<p id="second">', '<p id="since">A passage the site added since.</p><p id="second">');
  await page.reload();
  await highlight(page, "since");
  await expect.poll(() => state.uploads.length).toBe(2);
  expect(state.uploads[1].html).toContain("A passage the site added since.");
  await expect.poll(() => state.refreshes).toBe(2);
});

test("the page kept is the page as it was when the passage was marked", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  let release = () => {};
  state.holdHighlight = new Promise<void>(resolve => { release = resolve; });
  await highlight(page, "passage");
  await expect.poll(() => state.highlightPosts).toBe(1);
  // While the highlight is being saved the page moves on, and then the reader does.
  await page.frameLocator("iframe").locator("#second").evaluate(node => { node.textContent = "Rewritten after the mark"; });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  state.holdHighlight = null; release();
  await expect.poll(() => state.uploads.length).toBe(1);
  expect(state.uploads[0].html).toContain("A second independently annotated passage.");
  expect(state.uploads[0].html).not.toContain("Rewritten after the mark");
});

test("rules a page built in script, and its own zoom, are kept as the page drew them", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  // CSS-in-JS and MathJax's CHTML glyphs exist only in the CSSOM; the reader's
  // zoom is Delphi's, not the page's.
  state.sourceHtml = article.replace("<script>", `<style id="generated"></style><style id="typed">p{margin:0}</style><script>
    document.getElementById("generated").sheet.insertRule('mjx-c.mjx-c78::before{content:"x"}');
    document.getElementById("typed").sheet.insertRule(".late{color:red}", 1);
    const sheet = new CSSStyleSheet(); sheet.replaceSync(".adopted{font-weight:700}"); document.adoptedStyleSheets = [sheet];
  </script><script>`);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#passage")).toBeVisible();
  // macOS zooms by narrowing the frame's layout, so the width kept is the
  // frame's own.
  await page.getByLabel("More", { exact: true }).click();
  await page.getByRole("button", { name: /^Zoom webpage in/ }).click();
  await page.keyboard.press("Escape");
  await highlight(page, "passage");
  await expect.poll(() => state.uploads.length).toBe(1);
  const { html, width } = state.uploads[0];
  expect(html).toContain('mjx-c.mjx-c78::before { content: "x"; }');
  expect(html).toMatch(/p \{ margin: 0px; \}\s*\.late \{ color: red; \}/);
  expect(html).toContain(".adopted { font-weight: 700; }");
  expect(html).not.toMatch(/zoom|transform/);
  const inner = await page.frameLocator("iframe").locator("body").evaluate(() => innerWidth);
  expect(width).toBe(inner);
});

test("the cached view shows the page as annotated, and its marks place there", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  state.sourceHtml = article.replace('<p id="second">', '<p id="drawn">A passage the page drew for itself.</p><p id="second">');
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await highlight(page, "drawn");
  await expect.poll(() => state.uploads.length).toBe(1);
  await page.getByLabel("More", { exact: true }).click();
  // The row names the copy by the date it was kept.
  await expect(page.locator(".reader-menu-view time")).toHaveAttribute("datetime", "2026-09-22T13:00:00Z");
  await page.getByRole("button", { name: /View cached/ }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=cached/);
  await expect(page.frameLocator("iframe").locator("#drawn")).toHaveText("A passage the page drew for itself.");
  await expect.poll(() => paintCount(page)).toBe(1);
});

test("keeping the page fails without costing the annotation, and an older backend is not asked twice", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  state.refusePage = true;
  await highlight(page, "passage");
  await expect.poll(() => state.highlights.length).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.uploads).toHaveLength(0);
  // A backend from before page copies has no route for them.
  state.refusePage = false;
  state.pageRoute = false;
  const puts: string[] = [];
  page.on("request", request => { if (request.url().includes("/saved-page")) puts.push(request.method()); });
  await highlight(page, "second");
  await expect.poll(() => puts.length).toBe(1);
  await page.frameLocator("iframe").locator("#second").evaluate(node => node.insertAdjacentHTML("afterend", '<p id="more">More text arrived.</p>'));
  await highlight(page, "more");
  await expect.poll(() => state.highlights.length).toBe(3);
  await page.waitForTimeout(500);
  expect(puts).toEqual(["PUT"]);
});

test("a page copy nobody asked for is ignored, however it is addressed", async ({ page }) => {
  needsPageCopies();
  // The panel's own view of the frame's messages, so a test can replay one.
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    Object.assign(window, { frameMessages: seen });
    window.addEventListener("message", event => seen.push(event.data), true);
  });
  const state = await setup(page);
  await highlight(page, "passage");
  await expect.poll(() => state.uploads.length).toBe(1);
  // An answer to no request, and a replay of one already answered, both with
  // the right nonce and from the right window.
  await page.evaluate(() => {
    const frame = document.querySelector("iframe")!.contentWindow!;
    const messages = (window as unknown as { frameMessages: Record<string, unknown>[] }).frameMessages;
    const answered = messages.find(message => message?.type === "page-capture")!;
    const forged = { ...answered, request: "unsolicited", html: "<!DOCTYPE html><html><body><p>Something else entirely.</p></body></html>" };
    for (const data of [forged, { ...answered, html: String(answered.html).replace("important", "replayed") }])
      window.dispatchEvent(new MessageEvent("message", { data, source: frame }));
  });
  await page.waitForTimeout(1000);
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].html).not.toMatch(/Something else entirely|replayed/);
});

test("a site that refuses the text refresh still gets the page the reader annotated kept", async ({ page }) => {
  needsPageCopies();
  const state = await setup(page);
  state.refuseRefresh = true;
  await highlight(page, "passage");
  await expect.poll(() => state.refreshes).toBe(1);
  await expect.poll(() => state.uploads.length).toBe(1);
  expect(state.uploads[0].html).toContain("An exact <b>important</b> passage");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("with a bridge from before page copies, annotating refreshes as it did and sends no page", async ({ page }) => {
  const state = await setup(page);
  state.olderBridge = true;
  const puts: string[] = [];
  page.on("request", request => { if (request.url().includes("/saved-page")) puts.push(request.method()); });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#passage")).toBeVisible();
  await highlight(page, "passage");
  await expect.poll(() => state.refreshes).toBe(1);
  await page.waitForTimeout(1000);
  expect(puts).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Reply pins evidence through DOM replacement and reload", async ({ page }) => {
  await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByTestId("quote")).toContainText("important");
  await page.frameLocator("iframe").locator("article").evaluate(node => { node.textContent = "404 not found"; });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("button", { name: "Fixture send" }).click();
  await expect(page.getByTestId("evidence")).toContainText('"source":"captured"');
  const evidence = JSON.parse(await page.getByTestId("evidence").innerText());
  expect(evidence.texts.join("\n")).toContain("important");
  expect(evidence.texts.join("\n")).not.toContain("404 not found");
});

test("changed text remains readable in the list; unresolved marks do not jump", async ({ page }) => {
  await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => paintCount(page)).toBe(1);
  await page.frameLocator("iframe").locator("#passage").evaluate(node => { node.textContent = "Entirely changed passage"; });
  await page.getByRole("button", { name: /Annotations/ }).click();
  await expect(page.locator(".annotation-location")).toBeVisible();
  await expect(page.locator(".annotation-entry blockquote")).toContainText("important");
  await expect(page.locator(".annotation-target")).toHaveCount(0);
});

test("scaled frame geometry and Safari caret fallback keep marks clickable after zoom", async ({ page }) => {
  await setup(page, true);
  await select(page);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => paintCount(page)).toBe(1);
  await page.frameLocator("iframe").locator("body").evaluate(() => { Object.defineProperty(document, "caretPositionFromPoint", { value: undefined, configurable: true }); });
  // macOS zooms the page from its own control, which narrows the layout the
  // same way a stored render is scaled.
  await page.getByLabel("More", { exact: true }).click();
  await page.getByRole("button", { name: /^Zoom webpage in/ }).click();
  await page.keyboard.press("Escape");
  await page.frameLocator("iframe").locator("#passage b").click();
  await expect(page.getByRole("button", { name: "Add note", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
});

test("Escape preserves an existing note and cancels a new empty note", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.locator('[contenteditable="true"]').press("Escape");
  await expect.poll(() => state.highlights.length).toBe(0);
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("Keep this note");
  await page.locator('[contenteditable="true"]').press("Enter");
  await page.locator(".page-note-icon").click();
  await page.locator(".note-card-preview").dblclick();
  await page.locator('[contenteditable="true"]').fill("Discard this edit");
  await page.locator('[contenteditable="true"]').press("Escape");
  expect(state.notes[0].body).toBe("Keep this note");
  expect(state.highlights).toHaveLength(1);
});

test("an edit made during an in-flight save stays open and can be saved next", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("First version");
  let release = () => {};
  state.holdSave = new Promise<void>(resolve => { release = resolve; });
  await editor.press("Enter");
  await expect.poll(() => state.saving).toBe(true);
  await editor.fill("Newer version");
  state.holdSave = null; release();
  await expect.poll(() => state.notes[0]?.body).toBe("First version");
  await expect(editor).toContainText("Newer version");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  expect(state.notes[0].body).toBe("Newer version");
});

test("overlapping passages retain independent records and use the list to disambiguate", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => paintCount(page)).toBe(1);
  await expect(page.getByRole("button", { name: "Highlight", exact: true })).toHaveCount(0);
  await page.frameLocator("iframe").locator("#passage b").evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await expect(page.getByRole("button", { name: "Highlight", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => paintCount(page)).toBe(2);
  await page.frameLocator("iframe").locator("#passage b").click();
  await expect(page.locator(".annotation-selected")).toHaveCount(2);
  expect(state.highlights).toHaveLength(2);
  await page.getByRole("button", { name: "Delete highlight", exact: true }).first().click();
  await expect.poll(() => paintCount(page)).toBe(1);
  expect(state.highlights[0].text).toBe("important");
});

test("the frame only receives temporary paint handles and cannot spoof a sibling message", async ({ page }) => {
  const state = await setup(page);
  await page.frameLocator("iframe").locator("body").evaluate(() => {
    const received: unknown[] = [];
    Object.assign(window, { annotationMessages: received });
    window.addEventListener("message", e => { if (e.data?.type === "annotation-paint") received.push(e.data); });
  });
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("Private reader thought");
  await page.locator('[contenteditable="true"]').press("Enter");
  await expect.poll(() => state.notes.length).toBe(1);
  const paint = await page.frameLocator("iframe").locator("body").evaluate(() => (window as unknown as { annotationMessages: unknown[] }).annotationMessages);
  expect(JSON.stringify(paint)).not.toContain("Private reader thought");
  expect(JSON.stringify(paint)).not.toContain('"h1"');
  expect(JSON.stringify(paint)).not.toContain('"anchor"');
  await page.evaluate(() => window.postMessage({source:"delphi-page",type:"annotation-unavailable",nonce:"forged",generation:0},"*"));
  await expect.poll(() => paintCount(page)).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});


for (const rendered of [false, true]) {
  test(`${rendered ? "Rendered" : "HTML"} pages keep live, cached and reload separate, and none of them refreshes`, async ({ page }) => {
    const state = await setup(page, false, rendered);
    const paragraph = page.frameLocator("iframe").locator("#second");
    await expect(paragraph).toContainText("second independently");
    await expect(page.locator("iframe")).toHaveAttribute("src", /view=live/);
    const originalCache = state.copy.html;
    state.sourceHtml = article.replace("A second independently annotated passage.", "New source version");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(paragraph).toHaveText("New source version");
    await page.getByLabel("More", { exact: true }).click();
    // The copy is kept by annotating, not by a button.
    await expect(page.getByRole("button", { name: /Update cache/ })).toHaveCount(0);
    await expect(page.locator(".reader-menu-view time")).toHaveAttribute("datetime", "2026-09-22T12:00:00Z");
    await page.getByRole("button", { name: /View cached/ }).click();
    await expect(paragraph).toContainText("second independently");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(paragraph).toContainText("second independently");
    expect(state.pageLoads.at(-1)).toBe("cached");
    await page.getByLabel("More", { exact: true }).click();
    await page.getByRole("button", { name: "View live", exact: true }).click();
    await expect(paragraph).toHaveText("New source version");
    expect(state.copy.html).toBe(originalCache);
    expect(state.refreshes).toBe(0);
  });
}

test("an older backend cannot silently present a cached rendering as live", async ({ page }) => {
  const state = await setup(page, false, true);
  state.supportsViews = false;
  await page.reload();
  await expect(page.getByText("Error: Update the Delphi backend to use live and cached document views.", {exact:true})).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("a live page that cannot be loaded falls back to the cached copy and says so", async ({ page }) => {
  const state = await setup(page);
  state.unavailable = ["live"];
  state.pageLoads = [];
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=cached/);
  await expect(page.frameLocator("iframe").locator("#second")).toContainText("second independently");
  // Said as a failure that Reload may undo, never as a site the reader cannot show.
  // The year is said only for a copy from another year than the clock's.
  await expect(page.locator(".page-notice")).toHaveText(/^Saved copy · Sep 22(, 2026)?\. The live page didn’t load just now\. Reload tries again\.$/);
  expect(state.pageLoads).toEqual(["live", "cached"]);
  await page.getByLabel("More", { exact: true }).click();
  await expect(page.getByRole("button", { name: "View live", exact: true })).toBeVisible();
  state.unavailable = [];
  await page.getByRole("button", { name: "View live", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=live/);
  await expect(page.locator(".page-notice")).toHaveCount(0);
});

test("Reload over a copy shown because the live page failed tries the live page again", async ({ page }) => {
  const state = await setup(page);
  state.unavailable = ["live"];
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator(".page-notice")).toContainText("Reload tries again");
  state.unavailable = [];
  state.pageLoads = [];
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=live/);
  await expect(page.locator(".page-notice")).toHaveCount(0);
  expect(state.pageLoads).toEqual(["live"]);
});

test("a site that only runs on its own address shows the saved copy and says why", async ({ page }) => {
  const state = await setup(page);
  state.unavailable = ["live"];
  state.unavailableReason = "own-address";
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#second")).toContainText("second independently");
  // Read as a bug unless the reason is said: the live page is never coming.
  await expect(page.locator(".page-notice")).toHaveText(/^Saved copy · Sep 22(, 2026)?\. This site only shows its pages on its own website\. Showing the cached copy here\.$/);
});

test("with neither view available the reader says so once instead of retrying", async ({ page }) => {
  const state = await setup(page);
  state.unavailable = ["live", "cached"];
  state.pageLoads = [];
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByText("The live page could not be loaded, and no cached copy is saved.", { exact: true })).toBeVisible();
  expect(state.pageLoads).toEqual(["live", "cached"]);
});

test("a page cannot claim a view it was not asked for", async ({ page }) => {
  const state = await setup(page);
  state.sourceHtml = article.replace("<html>", '<html data-delphi-unavailable="cached">');
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#second")).toContainText("second independently");
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=live/);
  await expect(page.locator(".panel-error")).toHaveCount(0);
});

// A hosted demo is a few words of wrapper around a frame holding the page
// itself: the wrapper has no text to count and never hears a click in the frame.
const framedPage = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Hosted demo</title><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%}</style></head><body>${body}<script>${bridge}</script></body></html>`;
const wrapper = (height: string) => framedPage(`<p id="owner" style="margin:0;height:40px">demo</p><iframe id="app" style="height:${height}" srcdoc="<button>Run</button><p>The application draws itself in here, out of the wrapper's sight.</p>"></iframe>`);
const hosted = wrapper("calc(100% - 40px)");

test("only a page with nothing written and nothing drawn is called unreadable", async ({ page }) => {
  needsEmbeds();
  const state = await setup(page);
  const show = async (html: string) => { state.sourceHtml = html; await page.getByRole("button", { name: "Reload", exact: true }).click(); };
  // A word and a tracking frame: the page a failed boot leaves behind.
  await show(wrapper("1px"));
  await expect(page.locator(".page-notice")).toBeVisible();
  for (const [html, shown] of [
    [hosted, page.frameLocator("iframe").frameLocator("#app").getByRole("button")],
    [framedPage(`<img id="shown" alt="" width="400" height="300" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`), page.frameLocator("iframe").locator("#shown")],
    [framedPage(`<p id="shown">Nothing has been published at this address yet.</p>`), page.frameLocator("iframe").locator("#shown")],
  ] as const) {
    await show(html);
    await expect(shown).toBeVisible();
    // Past the first settle check, which is what raised the notice above.
    await page.waitForTimeout(2500);
    await expect(page.locator(".page-notice")).toHaveCount(0);
  }
});

test("a click inside a frame the page embeds counts as reading", async ({ page }) => {
  needsEmbeds();
  const state = await setup(page);
  state.sourceHtml = hosted;
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const frame = page.frameLocator("iframe"), run = frame.frameLocator("#app").getByRole("button"), engaged = page.getByTestId("engaged");
  await expect(run).toBeVisible();
  await expect(engaged).toHaveText("0");
  // Focus is in the app, as it is when the reader has just used the library.
  await run.click();
  await expect(engaged).toHaveText("1");
  // More clicks in the same frame move no focus and need not be heard again.
  await frame.locator("#owner").click();
  await expect(engaged).toHaveText("2");
  // Focus is now in the wrapper, which sees itself lose it to the frame.
  await run.click();
  await expect(engaged).toHaveText("3");
  // And back in the app again, by a click on the strip above the panel.
  await page.mouse.click(400, 24);
  await run.click();
  await expect(engaged).toHaveText("4");
});

/** A saved Notion page: its frame is the window's height, and its own scroller holds the blocks. */
function windowed(blocks: number, drawn: number) {
  const block = (i: number) => i === 2
    ? `<p id="passage">An exact <b>important</b> passage with 😀 evidence.</p>`
    : `<p id="b${i}" style="height:60px;margin:0">Block ${i} of the book, kept as the browser drew it.</p>`;
  const rows = Array.from({ length: blocks }, (_, i) => i < drawn ? block(i) : `<div style="height:60px"></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>The book</title><style>html,body{margin:0;height:100%;overflow:hidden}main{height:100vh;overflow:auto;font:16px Georgia}</style></head><body><main id="scroller">${rows}</main><script>${bridge}</script></body></html>`;
}

test("a page added at its first window waits behind a reading state, and opens whole once read", async ({ page }) => {
  const state = await setup(page, false, true, "?partial");
  state.unavailable = ["live"];
  state.unavailableReason = "own-address";
  state.copy = { html: windowed(120, 30) };
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // The first window ends mid-page as if it were all of it: not shown as the page.
  const reading = page.locator(".document-loading.is-reading");
  await expect(reading).toBeVisible();
  await expect(reading).toContainText("Reading the rest of this page");
  await expect(page.locator(".page-notice")).toHaveCount(0);
  // Nor reached under the cover: the reader cannot click or scroll into it.
  expect(await page.evaluate(() => {
    const frame = document.querySelector("iframe")!.getBoundingClientRect();
    return document.elementFromPoint(frame.x + frame.width / 2, frame.y + frame.height / 2)?.closest(".is-reading") !== null;
  })).toBe(true);

  state.copy = { html: windowed(120, 120) };
  const loads = state.pageLoads.length;
  await page.getByRole("button", { name: "Fixture whole copy" }).click();
  await expect.poll(() => state.pageLoads.length).toBe(loads + 1);
  expect(state.pageLoads.at(-1)).toBe("cached");
  await expect(reading).toHaveCount(0);
  await expect(page.frameLocator("iframe").locator("#b119")).toHaveCount(1);
  await expect(page.locator(".page-notice")).toContainText("only shows its pages on its own website");
});

test("the reader may read a copy's first window while the rest is read, and is told the rest is coming", async ({ page }) => {
  const state = await setup(page, false, true, "?partial");
  state.unavailable = ["live"];
  state.unavailableReason = "own-address";
  state.copy = { html: windowed(120, 30) };
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // A throttled capture can be half an hour away; the reader need not wait on it.
  await page.getByRole("button", { name: "Read what’s here", exact: true }).click();
  await expect(page.locator(".document-loading.is-reading")).toHaveCount(0);
  await expect(page.frameLocator("iframe").locator("#b29")).toBeVisible();
  await expect(page.locator(".page-notice")).toContainText("The rest of the page is still being read and appears here when it is.");
  state.copy = { html: windowed(120, 120) };
  await page.getByRole("button", { name: "Fixture whole copy" }).click();
  await expect(page.frameLocator("iframe").locator("#b119")).toHaveCount(1);
  await expect(page.locator(".page-notice")).not.toContainText("still being read");
});

test("scrolling a page-height sidebar never stands in for the reader's place in the article", async ({ page }) => {
  const state = await setup(page);
  const prose = Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i} of a documentation page, long enough to scroll.</p>`).join("");
  state.sourceHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Docs</title></head><body style="margin:0"><nav id="side" style="position:fixed;left:0;top:0;width:200px;height:100vh;overflow:auto"><div style="height:3000px">Contents</div></nav><article style="margin-left:220px">${prose}</article><script>${bridge}</script></body></html>`;
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#side")).toBeVisible();
  await frame.locator("body").evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(400);
  await frame.locator("#side").evaluate(node => { node.scrollTop = 500; });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(frame.locator("#side")).toBeVisible();
  await expect.poll(() => frame.locator("body").evaluate(() => window.scrollY)).toBe(1200);
});

/** What the webpage's ⋮ holds, top to bottom, as a reader reads it. */
const menuRows = (page: Page) => page.locator(".reader-menu-items > :not(hr)").evaluateAll(rows => rows.map(row => row.querySelector(".reader-menu-label")!.textContent));
const more = (page: Page) => page.getByLabel("More", { exact: true });

test("a webpage's bar keeps Reload and Notes out, and ⋮ holds the rest", async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(() => {
    const opened: string[] = [];
    Object.assign(window, { opened });
    window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  });
  // At rest: Reload, the notes list and ⋮, each a 26px circle.
  const buttons = page.locator(".page-chrome-actions .icon-button");
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) expect(await button.boundingBox()).toMatchObject({ width: 26, height: 26 });
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Annotations/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open in browser|Home/ })).toHaveCount(0);

  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["View cached", "Zoom", "Open in browser"]);
  // The copy's row wears the project's colour; the menu stays inside the viewer.
  await expect(page.locator(".reader-menu-view .reader-menu-meta")).toHaveText("Sep 22");
  await expect(page.locator(".reader-menu-dot")).toHaveCSS("background-color", "rgb(62, 123, 201)");
  const menu = (await page.locator(".reader-menu-items").boundingBox())!;
  const shell = (await page.locator(".page-shell").boundingBox())!;
  expect(menu.x + menu.width).toBeLessThanOrEqual(shell.x + shell.width + 0.5);
  expect(await page.locator(".reader-menu-item").first().evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(12);

  // Zooming leaves the menu open, so two steps can be seen; the readout resets.
  await page.getByRole("button", { name: /^Zoom webpage in/ }).click();
  await page.getByRole("button", { name: /^Zoom webpage in/ }).click();
  await expect(page.locator(".reader-menu-zoom-value")).toHaveText("125%");
  await page.locator(".reader-menu-zoom-value").click();
  await expect(page.locator(".reader-menu-zoom-value")).toHaveText("100%");
  await expect(page.locator(".reader-menu-zoom-value")).toBeDisabled();

  // Escape puts it away, and so does a click in the page.
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-menu-items")).toBeHidden();
  await more(page).click();
  await page.frameLocator("iframe").locator("#second").click();
  await expect(page.locator(".reader-menu-items")).toBeHidden();

  await more(page).click();
  await page.getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect(page.locator(".reader-menu-items")).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["https://article.example/read"]);

  // The same row switches to the copy and back, without its date the second time.
  await more(page).click();
  await page.getByRole("button", { name: /^View cached/ }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=cached/);
  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["View live", "Zoom", "Open in browser"]);
  await expect(page.locator(".reader-menu-view .reader-menu-meta")).toHaveCount(0);
  await expect(page.locator(".reader-menu-dot")).toHaveCSS("background-color", "rgb(62, 123, 201)");
  await page.getByRole("button", { name: "View live", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /view=live/);
  expect(state.refreshes).toBe(0);
});

test("after a link, ⋮ offers the way back and saving the page, below Open in browser", async ({ page }) => {
  const state = await setup(page);
  const next = "https://article.example/next";
  state.sourceHtml = article.replace('<p id="second">', `<p><a id="onward" href="${next}">Read on</a></p><p id="second">`);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.route("**/navigation", route => route.fulfill({ json: { action: "/api/projects/project/papers/paper/onward", url: next, token: "t", sandbox: "allow-scripts", allow: "" } }));
  await page.route("**/onward*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><base href="${next}" data-delphi-frame=""><title>Next</title></head><body><p id="later">The next page.</p><script>${bridge}</script></body></html>` }));

  await page.frameLocator("iframe").locator("#onward").click();
  await expect(page.frameLocator("iframe").locator("#later")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["Zoom", "Open in browser", "Back to the first page", "Save as new document"]);
  await page.getByRole("button", { name: "Save as new document", exact: true }).click();
  await expect(page.getByTestId("saved")).toHaveText(next);
  await expect(page.locator(".reader-menu-items")).toBeHidden();

  await more(page).click();
  await page.getByRole("button", { name: "Back to the first page", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#onward")).toBeVisible();
  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["View cached", "Zoom", "Open in browser"]);
});

test("Escape in ⋮ closes only the menu: a note being written stays open, and focus returns to ⋮", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("Half a thought");
  await more(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".reader-menu-items")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-menu-items")).toBeHidden();
  await expect(more(page)).toBeFocused();
  await expect(page.locator('[contenteditable="true"]')).toHaveText("Half a thought");
  expect(state.highlights).toHaveLength(1);
});
