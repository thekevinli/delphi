import { test, expect, type Locator, type Page } from "@playwright/test";
import { serveLibrary } from "./settings-projects-fixture";
import { releaseUnheard } from "./unheard-release-fixture";

async function setup(page: Page, query = "") {
  const state = await serveLibrary(page, new URLSearchParams(query));
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`/tests/browser/harness.html?library&paper=archs${query}`);
  await expect(row(page, "vLLM-Omni")).toBeVisible();
  return state;
}
const row = (page: Page, title: string) => page.locator(".paper-row-main", { hasText: title });
const slot = (page: Page) => page.locator(".paper-list > .paper-drop-slot.open");
const elsewhere = (page: Page, name: string) => page.getByRole("region", { name: `Move to ${name}` });
const log = (page: Page) => page.getByTestId("library-log");

/** Press a row and carry it just past the slop, leaving it in the air. */
async function lift(page: Page, title: string) {
  const from = (await row(page, title).boundingBox())!;
  await page.mouse.move(from.x + 80, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + from.height / 2 - 12, { steps: 4 });
  await expect(page.locator(".paper-row.is-lifted")).toHaveCount(1);
}

/** Carry the held paper onto a point of `target`, re-aiming until the target
 *  has stopped moving: a gap that opens on the way moves what is below it, and
 *  a card at the list's foot rides the autoscroll until the list ends. */
async function carry(page: Page, target: Locator, at: (box: { x: number; y: number; width: number; height: number }) => { x: number; y: number }) {
  let point = at((await target.boundingBox())!);
  await page.mouse.move(point.x, point.y, { steps: 8 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(150);
    const now = at((await target.boundingBox())!);
    if (Math.abs(now.y - point.y) < 1) return;
    point = now;
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
  throw new Error("the target never came to rest under the pointer");
}

test("a held row lifts as a tilted card, leaves its seat as an outline, and opens a gap where it would land", async ({ page }) => {
  const state = await setup(page);
  await lift(page, "vLLM-Omni");
  // The Settings sheet's card: white, tilted, over everything, its seat kept.
  const card = row(page, "vLLM-Omni");
  await expect(card).toHaveClass(/dragging/);
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(card).toHaveCSS("transform", /matrix\(0\.99/);
  await expect(page.locator(".paper-row.is-lifted")).toHaveAttribute("data-paper-id", "vllm");
  // Only the gaps away from its own seat open; over the seat, none does.
  await expect(slot(page)).toHaveCount(0);

  // Aimed once, as a hand held still: the gap that opens above the first row
  // moves it down, but the landing is read from the seats the rows had when the
  // lift began, so it stays before that row. Chasing the moved row (`carry`)
  // would cross its old midpoint whenever its title wraps taller than the gap.
  const first = (await row(page, "Toward Recursive").boundingBox())!;
  await page.mouse.move(first.x + 120, first.y + 8, { steps: 8 });
  await expect(slot(page)).toHaveCount(1);
  await expect(slot(page)).toHaveAttribute("data-paper-slot", "0");
  await expect(slot(page)).toHaveCSS("height", "58px");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["vllm", "glm", "archs", "knapformer", "miles", "sglang"] },
  }]);
  await expect(page.locator(".paper-row-main strong").first()).toHaveText(/^vLLM-Omni/);
  // The drop is not a click: nothing was opened, and the gaps are gone.
  await expect(log(page)).toHaveText("");
  await expect(page.locator(".paper-drop-slot")).toHaveCount(0);
  // Let go, the card eases back rather than snapping.
  await expect(card).toHaveCSS("transition-property", /transform/);
});

test("a release the page never heard lands the paper where it was let go, and the card stops following", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "how Chromium ends a capture it never saw released");
  const state = await setup(page);
  await lift(page, "vLLM-Omni");
  const first = (await row(page, "Toward Recursive").boundingBox())!;
  await page.mouse.move(first.x + 120, first.y + 8, { steps: 8 });
  await expect(slot(page)).toHaveAttribute("data-paper-slot", "0");
  // Let go over the first gap; the hand is already further down the list by
  // the time the page finds out, and it lands where it was let go.
  await releaseUnheard(page, first.x + 120, first.y + 240);
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["vllm", "glm", "archs", "knapformer", "miles", "sglang"] },
  }]);
  await expect(page.locator(".paper-row-main.dragging")).toHaveCount(0);
  await expect(page.locator(".paper-drop-slot")).toHaveCount(0);
  await expect(log(page)).toHaveText("");
  // Nothing is held any more: moving on carries nothing and drops nothing.
  await page.mouse.move(first.x + 120, first.y + 300, { steps: 4 });
  await expect(page.locator(".paper-row.is-lifted")).toHaveCount(0);
  await page.mouse.up();
  expect(state.writes).toHaveLength(1);
  await expect(log(page)).toHaveText("");
  // No click follows a release nobody heard, so none is left to be swallowed.
  await row(page, "KnapFormer").click();
  await expect(log(page)).toHaveText("paper knapformer");
});

test("a row that never held the pointer still follows it and lands where it is let go", async ({ page }) => {
  // The capture is dropped before it is taken when the move after the press
  // carries no button; then the release is heard on whatever is under the
  // pointer, never on the row. Here it is never taken at all.
  const state = await setup(page);
  await page.evaluate(() => { Element.prototype.setPointerCapture = () => undefined; });
  await lift(page, "vLLM-Omni");
  const first = (await row(page, "Toward Recursive").boundingBox())!;
  await page.mouse.move(first.x + 120, first.y + 8, { steps: 8 });
  await expect(slot(page)).toHaveAttribute("data-paper-slot", "0");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["vllm", "glm", "archs", "knapformer", "miles", "sglang"] },
  }]);
  await expect(page.locator(".paper-row.is-lifted")).toHaveCount(0);
  // The release was heard off the row, so no click followed it to swallow.
  await expect(log(page)).toHaveText("");
  await row(page, "KnapFormer").click();
  await expect(log(page)).toContainText("paper knapformer");
});

test("a row let go over its own seat changes nothing, and a click still opens the paper", async ({ page }) => {
  const state = await setup(page);
  await lift(page, "vLLM-Omni");
  const own = (await page.locator(".paper-row.is-lifted").boundingBox())!;
  await page.mouse.move(own.x + 120, own.y + own.height / 2 + 6, { steps: 4 });
  await expect(slot(page)).toHaveCount(0);
  await page.mouse.up();
  expect(state.writes).toEqual([]);

  await row(page, "vLLM-Omni").click();
  await expect(log(page)).toHaveText("paper vllm");
});

test("the other projects appear below the rows while a paper is held, and one takes it", async ({ page }) => {
  const state = await setup(page);
  await expect(page.locator(".paper-move-zone")).toHaveCount(0);
  await lift(page, "vLLM-Omni");
  await expect(page.locator(".paper-move-project")).toHaveCount(4);
  await expect(elsewhere(page, "Inference Framework")).toHaveCount(0);

  const target = elsewhere(page, "Optimizers");
  await carry(page, target, box => ({ x: box.x + 120, y: box.y + 14 }));
  await expect(target).toHaveClass(/drop-target/);
  await expect(target.locator(".paper-drop-slot")).toHaveClass(/open/);
  // Off the rows, no gap opens among them.
  await expect(slot(page)).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "POST", path: "/api/projects/inference/papers/vllm/move",
    body: { project_id: "optimizers" },
  }]);
  await expect(row(page, "vLLM-Omni")).toHaveCount(0);
  await expect(page.locator(".paper-move-zone")).toHaveCount(0);
  await expect(log(page)).toHaveText("");
});

test("a project with no room takes no drop", async ({ page }) => {
  const state = await setup(page, "&max=2");
  await lift(page, "vLLM-Omni");
  const full = elsewhere(page, "Scaling Law");
  await expect(full).toHaveClass(/is-full/);
  await carry(page, full, box => ({ x: box.x + 120, y: box.y + 14 }));
  await expect(page.locator(".drop-target")).toHaveCount(0);
  await page.mouse.up();
  expect(state.writes).toEqual([]);
});

test("a done paper opens no gap among its own rows, but can still be moved to another project", async ({ page }) => {
  const state = await setup(page);
  await lift(page, "SGLang");
  await carry(page, row(page, "Toward Recursive"), box => ({ x: box.x + 120, y: box.y + 8 }));
  await expect(slot(page)).toHaveCount(0);
  const target = elsewhere(page, "Reading list");
  await carry(page, target, box => ({ x: box.x + 120, y: box.y + 14 }));
  await expect(target).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "POST", path: "/api/projects/inference/papers/sglang/move",
    body: { project_id: "empty" },
  }]);
});
