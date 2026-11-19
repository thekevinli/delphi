import { test, expect, type Page } from "@playwright/test";
import { digestFixture } from "./digest-fixture";
import { modelLabel } from "../../app/lib/chat-model-policy";

// The pane on its own, in a reader-sized box: what a stored digest renders.
// The header toggle, the states and live generation are digest-reader.spec.ts.
async function setup(page: Page, options: { asset?: boolean; fail?: boolean; prose?: string; width?: number } = {}) {
  const detail = structuredClone(digestFixture);
  if (options.prose) detail.digest!.contentMarkdown += `\n\n${options.prose}`;
  if (options.asset) detail.digest!.assets.push({ id: "figure-1", inventoryId: "source-1", kind: "source-figure", caption: "A captured source figure", alt: "Source figure", teachingValue: "Evidence", afterEvidenceId: 1, page: 1, mimeType: "image/svg+xml", width: 120, height: 50, bytes: 200 });
  let generations = 0;
  let release: () => void = () => {};
  await page.route("**/api/**", async route => {
    if (route.request().url().includes("/assets/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="50"><rect width="120" height="50" fill="#fef1e6"/></svg>' });
    if (route.request().method() === "POST") {
      generations++;
      expect(route.request().postDataJSON()).toEqual({ force: true });
      // Held until the spec has seen the footer while it works.
      await new Promise<void>(resolve => { release = resolve; });
      if (options.fail) return route.fulfill({ status: 503, json: { detail: "Please retry" } });
      detail.digest!.contentMarkdown = "## Updated overview\n\nA regenerated digest.\n\n### New section\n\nNew body.";
    }
    return route.fulfill({ json: detail });
  });
  await page.goto(`/tests/browser/harness.html?digest${options.width ? `&width=${options.width}` : ""}`);
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  return { generations: () => generations, release: () => release() };
}
const pane = (page: Page) => page.locator('section[aria-label="Digest"]');
const contents = (page: Page) => pane(page).getByRole("navigation", { name: "Contents", exact: true });

test("contents, complete Markdown, equations, assets and citation targets", async ({ page }) => {
  await setup(page, { asset: true, prose: "### A closing section whose heading outruns the contents column" });
  // The pane has no top bar of its own: the reader's header already names the document.
  await expect(pane(page).getByText("Research digest", { exact: true })).toHaveCount(0);
  await expect(pane(page).getByText("On this page", { exact: true })).toHaveCount(0);
  await expect(contents(page).getByRole("link")).toHaveCount(6);
  // Its title says more than the header's "SGLang (2312.07104v2)", so it stays: as the title, and out of the contents.
  const title = page.locator(".digest-document > h1.digest-title");
  await expect(title).toHaveText(/^SGLang: co-designing/);
  await expect(contents(page).getByRole("link", { name: /^SGLang/ })).toHaveCount(0);
  expect(await contents(page).evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(200);
  const long = contents(page).getByRole("link", { name: /^A closing section/ });
  await expect(long.locator(".kb-related-title")).toHaveClass(/is-long/);
  await long.hover();
  await expect(long.locator(".kb-related-track")).toHaveCSS("animation-name", "kb-related-ticker");
  expect(await long.locator(".kb-related-title").evaluate(node => getComputedStyle(node).maskImage)).toContain("linear-gradient");
  const ids = await page.locator(".digest-document :is(h2,h3)").evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.locator(".digest-citation").first()).toHaveText("(pp. 1, 7)");
  await expect(page.locator(".digest-citation").first()).toHaveAttribute("href", "/@reader/project/sglang?focusPage=1");
  await expect(page.locator(".digest-code-block")).toHaveCount(1);
  await expect(page.locator(".digest-code-block pre")).toContainText('for i, f in enumerate(forks):');
  expect(await page.locator(".digest-code-block pre").textContent()).toContain('\n\n    forks');
  await expect(page.locator(".digest-document code").filter({ hasText: /^gen\(name\)$/ })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "(p. 3)", exact: true })).toBeVisible();
  await expect(page.locator(".digest-document > ul > li")).toHaveCount(2);
  await expect(page.locator(".digest-asset")).toHaveCount(1);
  expect(await page.locator(".digest-asset").evaluate(node => node.previousElementSibling?.textContent)).toContain("higher throughput");
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expect(page.locator("math mfrac")).toHaveCount(1);
  expect(await page.locator(".digest-document").evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(620);

  // Contents follow the reading, and a contents link moves it.
  const current = contents(page).locator('[aria-current="location"]');
  await expect(current).toHaveText("Overview");
  const runtime = contents(page).getByRole("link", { name: "Runtime", exact: true });
  await runtime.click();
  await expect(runtime).toHaveAttribute("aria-current", "location");
  await expect(current).toHaveCount(1);
  const equation = page.locator("math[display='block']");
  await expect(equation).toBeInViewport();
  expect(await equation.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(30);
  await page.locator(".digest-reading-scroll").evaluate(node => node.scrollTo({ top: node.scrollHeight }));
  await expect(contents(page).locator('[aria-current="location"]')).toHaveText("Results");
  await contents(page).getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => page.locator(".digest-reading-scroll").evaluate(node => node.scrollTop)).toBe(0);

  // A page citation hands the reader back to the document, at that page.
  await page.locator(".digest-citation").first().click();
  // The rest of the address stays; only the place changes.
  await expect(page).toHaveURL(/sglang\?digest=&focusPage=1$/);
  await expect(page.getByTestId("shown")).toHaveText("document");
});

test("an image the digest's prose embeds is never fetched, and code holding a formula stays code", async ({ page }) => {
  const remote: string[] = [];
  page.on("request", request => { if (new URL(request.url()).hostname === "example.com") remote.push(request.url()); });
  await setup(page, { prose: [
    'A plot ![plot](https://example.com/plot.png "Caption") and ![chart][ref] sit in the prose.',
    "Written literally: `$$\\frac{x}{y}$$`.",
    '[ref]: https://example.com/chart.png "Chart"',
  ].join("\n\n") });
  const prose = page.locator(".digest-document");
  await expect(prose.locator("p", { hasText: "A plot" })).toHaveText("A plot  and  sit in the prose.");
  await expect(prose.locator("img")).toHaveCount(0);
  await expect(prose.locator("p", { hasText: "Written literally" }).locator("code")).toHaveText("$$\\frac{x}{y}$$");
  expect(remote).toEqual([]);
});

test("the footer names the digest's model and date, and Regenerate replaces the contents", async ({ page }) => {
  const state = await setup(page);
  const footer = pane(page).locator(".digest-footer");
  await expect(footer).toContainText(`${modelLabel(digestFixture.paper.digest!.model!)} · Oct 26`);
  const regenerate = footer.getByRole("button", { name: "Regenerate digest", exact: true });
  await expect(regenerate).toHaveText("Regenerate");
  await regenerate.click();
  // The stored digest stays readable while the new one is written.
  await expect(regenerate).toHaveText("Regenerating…");
  await expect(regenerate).toBeDisabled();
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  state.release();
  await expect(pane(page).locator(".digest-document")).toContainText("A regenerated digest");
  await expect(contents(page).getByRole("link", { name: "New section" })).toBeVisible();
  // A digest that opens on a section has no title: the section is listed and reads at a section's size.
  await expect(contents(page).getByRole("link", { name: "Updated overview" })).toBeVisible();
  const opening = page.locator(".digest-document > h2:first-child");
  expect(await opening.evaluate(node => getComputedStyle(node).fontSize)).toBe(await page.locator(".digest-document > h3").evaluate(node => getComputedStyle(node).fontSize));
  await expect(regenerate).toHaveText("Regenerate");
  await expect(regenerate).toBeEnabled();
  expect(state.generations()).toBe(1);
});

test("a failed regenerate keeps the stored digest and says why in the footer", async ({ page }) => {
  const state = await setup(page, { fail: true });
  const footer = pane(page).locator(".digest-footer");
  await footer.getByRole("button", { name: "Regenerate digest", exact: true }).click();
  state.release();
  await expect(footer.getByRole("alert")).toContainText("Please retry");
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish" })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "Regenerate digest", exact: true })).toBeEnabled();
});

test("in a narrow pane the contents give way, nothing scrolls sideways, and code copy keeps its newlines", async ({ page }) => {
  await setup(page, { width: 420 });
  await expect(contents(page)).toBeHidden();
  expect(await pane(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator(".digest-reading-scroll").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.body.dataset.copied = text; } }, configurable: true }); });
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toHaveText("Copied");
  const source = await page.locator(".digest-code-block pre").textContent();
  expect(await page.locator("body").getAttribute("data-copied")).toBe(source);
  // Wide enough again, the contents come back.
  await page.locator(".reader-panel").evaluate(node => { (node as HTMLElement).style.width = "900px"; });
  await expect(contents(page)).toBeVisible();
});

test("a wider reader widens the contents and the measure, and sets the prose between even margins", async ({ page }) => {
  const layout = () => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const [toc, scroll, prose] = [box(".digest-toc"), box(".digest-reading-scroll"), box(".digest-document")];
    return { toc: Math.round(toc.width), prose: Math.round(prose.width), left: Math.round(prose.left - toc.right), right: Math.round(scroll.right - prose.right) };
  });
  await setup(page, { width: 760 });
  expect(await layout()).toMatchObject({ toc: 168, left: 30, right: 38 });
  await setup(page, { width: 1080 });
  const rail = await layout();
  expect(rail.toc).toBe(216);
  expect(rail.prose).toBeGreaterThan(660);
  expect(rail.left).toBeGreaterThanOrEqual(80);
  expect(Math.abs(rail.right - rail.left)).toBeLessThanOrEqual(16);
  await setup(page, { width: 1600 });
  const wide = await layout();
  expect(wide).toMatchObject({ toc: 248, prose: 760 });
  expect(Math.abs(wide.right - wide.left)).toBeLessThanOrEqual(16);
});
