import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";

// The frame script comes from the backend this app bundles: `npm run build`.
const sitePackages = (() => {
  const lib = new URL("../../../.delphi-build/python/lib/", import.meta.url);
  const python = readdirSync(lib).find(name => /^python3\.\d+$/.test(name));
  if (!python) throw new Error("No bundled backend; run npm run build first.");
  return new URL(`${python}/site-packages/delphi_core/`, lib);
})();
const backendFile = (file: string) => readFileSync(new URL(file, sitePackages), "utf8");
const bridge = backendFile("web_bridge.js").replace("/* ANNOTATION_IMPLEMENTATION */", backendFile("web_annotation_bridge.js"));

const PAGE = "https://alisawuffles.notion.site/alisa-s-book-of-llms";
const BLOCK = "2d17eb873605800a9149c2c8aec7252c";
const DASHED = "2d17eb87-3605-800a-9149-c2c8aec7252c";
// A saved copy of a public Notion page, as `render_frame` frames it: Notion's
// own section links carry ?pvs=25, and name a block by its id without dashes.
const notion = `<!doctype html><html><head><base href="${PAGE}" data-delphi-frame=""></head><body>
  <a id="section" href="/alisa-s-book-of-llms?pvs=25#${BLOCK}">Pretraining</a>
  <a id="missing" href="/alisa-s-book-of-llms?pvs=25#ffffffffffffffffffffffffffffffff">A block not here</a>
  <a id="other" href="/another-page?pvs=25#${BLOCK}">Another page</a>
  <a id="plain" href="#notes">Notes</a>
  <a id="malformed-away" href="https://other.example/p#100%">A malformed fragment elsewhere</a>
  <a id="malformed-here" href="#100%">A malformed fragment here</a>
  <div style="height:3000px"></div>
  <div data-block-id="${DASHED}"><h2>Pretraining</h2></div>
  <div style="height:3000px"></div>
  <h2 id="notes">Notes</h2>
  <div style="height:3000px"></div>
  <script>${bridge}</script></body></html>`;

async function reader(page: Page, copy = notion) {
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <iframe id="frame" style="width:900px;height:600px;border:0"></iframe>
    <script>window.messages = []; addEventListener("message", e => window.messages.push(e.data));</script></body></html>`);
  await page.$eval("#frame", (frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, copy);
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#section")).toBeVisible();
  return frame;
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { messages: { type: string; href?: string }[] }).messages
  .filter(message => message.type === "navigate" || message.type === "same-document")
  .map(message => ({ type: message.type, href: message.href })));
const scrollY = (page: Page) => page.frames()[1].evaluate(() => window.scrollY);

test("a Notion section link stays on its page and reaches the block it names", async ({ page }) => {
  const frame = await reader(page);
  await frame.locator("#section").click();
  // The page's own address: the document, and its annotations, are unchanged.
  await expect.poll(() => sent(page)).toEqual([{ type: "same-document", href: `${PAGE}#${BLOCK}` }]);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(2500);
  await expect(frame.locator(`[data-block-id="${DASHED}"]`)).toBeInViewport();
});

test("a fragment the page does not hold, or another page, is still a navigation", async ({ page }) => {
  const frame = await reader(page);
  await frame.locator("#missing").click();
  await frame.locator("#other").click();
  await expect.poll(() => sent(page)).toEqual([
    { type: "navigate", href: `${PAGE}?pvs=25#ffffffffffffffffffffffffffffffff` },
    { type: "navigate", href: `https://alisawuffles.notion.site/another-page?pvs=25#${BLOCK}` },
  ]);
  expect(await scrollY(page)).toBe(0);
});

test("in a copy whose rest is still being read, a section not drawn yet stays on its page", async ({ page }) => {
  // Clicked before the capture had read the rest, Notion's later sections
  // opened ?pvs=25 as a page of its own, which drew nothing readable.
  const frame = await reader(page, notion.replace("<html>", '<html data-delphi-render-partial="">'));
  await frame.locator("#missing").click();
  await frame.locator("#other").click();
  await expect.poll(() => sent(page)).toEqual([
    { type: "same-document", href: `${PAGE}#ffffffffffffffffffffffffffffffff` },
    { type: "navigate", href: `https://alisawuffles.notion.site/another-page?pvs=25#${BLOCK}` },
  ]);
  expect(await scrollY(page)).toBe(0);
});

test("a plain fragment link still scrolls to its element", async ({ page }) => {
  const frame = await reader(page);
  await frame.locator("#plain").click();
  await expect.poll(() => sent(page)).toEqual([{ type: "same-document", href: `${PAGE}#notes` }]);
  await expect(frame.locator("#notes")).toBeInViewport();
});

test("a malformed fragment is still the bridge's to handle, never the frame's", async ({ page }) => {
  const frame = await reader(page);
  // Decoding "100%" throws; before the bridge had said anything, the frame
  // would have followed the link itself.
  await frame.locator("#malformed-away").click();
  await frame.locator("#malformed-here").click();
  await expect.poll(() => sent(page)).toEqual([
    { type: "navigate", href: "https://other.example/p#100%" },
    { type: "same-document", href: `${PAGE}#100%` },
  ]);
  await expect(frame.locator("#section")).toBeVisible();
});

/** Images above it load as the reader arrives, and push the section down: here, the first spacer grows. */
const growAbove = (page: Page) => page.frames()[1].evaluate(() => {
  (document.querySelector('div[style="height:3000px"]') as HTMLElement).style.height = "5000px";
});

test("a section reached stays reached when the page above it grows on the way", async ({ page }) => {
  const frame = await reader(page);
  await frame.locator("#plain").click();
  // A live page's lazy figures took their height while the smooth scroll was
  // under way, which fixes its destination when it starts and keeps the
  // browser's scroll anchoring out of it: the reader stopped a section short.
  await growAbove(page);
  await expect(frame.locator("#notes")).toBeInViewport();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(8000);
});

test("once the reader scrolls, the page is theirs again", async ({ page }) => {
  const frame = await reader(page);
  await frame.locator("#plain").click();
  await expect(frame.locator("#notes")).toBeInViewport();
  // The jump has come to rest before the reader takes over.
  let resting = -1;
  await expect.poll(async () => { const now = await scrollY(page); const still = now === resting; resting = now; return still; }, { intervals: [250] }).toBe(true);
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => frame.locator("#notes").evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThan(200);
  await growAbove(page);
  await page.waitForTimeout(500);
  // Whatever growth above does to the view, nothing takes the reader back.
  expect(await frame.locator("#notes").evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThan(200);
});
