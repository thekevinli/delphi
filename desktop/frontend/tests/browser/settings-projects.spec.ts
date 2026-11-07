import { test, expect, type Locator, type Page } from "@playwright/test";
import { serveLibrary } from "./settings-projects-fixture";
import { releaseUnheard } from "./unheard-release-fixture";

async function setup(page: Page, query = "") {
  const state = await serveLibrary(page, new URLSearchParams(query));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/tests/browser/harness.html?settings-projects${query}`);
  await expect(page.getByRole("region", { name: "Inference Framework" })).toBeVisible();
  return state;
}
const group = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const row = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });
const log = (page: Page) => page.getByTestId("settings-log");

/** Bring a row to the middle of the pane, clear of the edges that autoscroll. */
async function centre(page: Page, title: string) {
  await row(page, title).evaluate(node => {
    const pane = node.closest(".settings-pane")!;
    const at = node.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    pane.scrollTop += at.top + at.height / 2 - (frame.top + frame.height / 2);
  });
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Press a row and carry it onto a point of `target`, leaving it in the air.
 *
 * Down the margin beside the cards and in from the side: a gap that opens on
 * the way pushes the rows under it, so a straight line to the target would
 * make where it lands depend on how many frames the journey took. Then re-aim
 * until the target stops moving, as the library rail's `carry` does: a row
 * lifted near the sheet's top edge autoscrolls it for as long as the pointer
 * is there, and a gap that opens at the target pushes the target down.
 */
async function lift(page: Page, title: string, target: Locator, at: (box: Box) => { x: number; y: number }) {
  const from = (await row(page, title).boundingBox())!;
  const margin = from.x + from.width + 30;
  await page.mouse.move(from.x + 120, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(margin, from.y + from.height / 2, { steps: 6 });
  await expect(page.locator(".account-paper-seat.is-lifted")).toHaveCount(1);
  await expect(page.locator(".account-drop-slot.open")).toHaveCount(0);
  let point = at((await target.boundingBox())!);
  await page.mouse.move(margin, point.y, { steps: 6 });
  await page.mouse.move(point.x, point.y, { steps: 6 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(150);
    const now = at((await target.boundingBox())!);
    if (Math.abs(now.y - point.y) < 1) return;
    point = now;
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
  throw new Error("the target never came to rest under the pointer");
}

test("each project is a labelled group over one card of its papers", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator(".account-section-heading > span")).toHaveText("5 projects · 12 papers");

  const inference = group(page, "Inference Framework");
  await expect(inference.getByRole("heading", { level: 4 })).toHaveText("Inference Framework");
  await expect(inference.locator(".account-project-count")).toHaveText("6");
  await expect(inference.locator(".settings-card")).toHaveCount(1);
  await expect(inference.locator(".account-paper-row")).toHaveCount(6);
  // Hairlines between rows, not a box around each; and no row chevron.
  await expect(inference.locator(".account-paper-row").nth(1)).toHaveCSS("border-top-width", "0px");
  await expect(inference.locator(".account-paper-seat").nth(1)).toHaveCSS("border-top-width", "1px");
  await expect(inference.locator(".account-paper-list")).not.toContainText("›");

  // Web or PDF comes from the stored source type: a linked PDF and a paper
  // stored with no kind are PDFs whatever their titles say.
  const meta = (title: string) => row(page, title).locator(".account-paper-meta");
  await expect(meta("Domain specific archs")).toHaveText("Web page");
  await expect(row(page, "Domain specific archs").locator(".kind-mark")).toHaveClass(/is-web/);
  await expect(meta("vLLM-Omni")).toHaveText("PDF");
  await expect(meta("KnapFormer")).toHaveText("PDF");
  await expect(row(page, "KnapFormer").locator(".kind-mark")).toHaveClass(/is-pdf/);
  await expect(meta("Miles v0.1")).toHaveText("PDF");

  // The open document and a finished one say so ahead of the kind.
  await expect(meta("Toward Recursive")).toHaveText("Open nowWeb page");
  await expect(row(page, "Toward Recursive")).toHaveAttribute("aria-current", "page");
  await expect(row(page, "Toward Recursive")).toHaveCSS("background-color", "rgb(251, 244, 242)");
  await expect(meta("SGLang")).toHaveText("DonePDF");
  // Done papers sink to the foot of their card.
  await expect(inference.locator(".account-paper-row").last()).toContainText("SGLang");

  await expect(group(page, "Reading list")).toContainText("No papers yet");
});

test("a row opens its paper and Open project opens the project", async ({ page }) => {
  await setup(page);
  await row(page, "vLLM-Omni").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(log(page)).toHaveText("paper inference/vllm");

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Open Scaling Law" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(log(page)).toContainText("navigate /@reader/scaling-law");
});

test("a paper dragged onto another project is filed where its gap opened", async ({ page }) => {
  const state = await setup(page);
  const target = group(page, "Scaling Law");
  await centre(page, "Test-Time Scaling Makes");
  await lift(page, "Miles v0.1", row(page, "Scaling up Test-Time"), box => ({ x: box.x + 200, y: box.y + 6 }));

  // Its place stays as an outline, the target card takes its project's colour,
  // and exactly one gap is open: before the row the pointer is on.
  await expect(group(page, "Inference Framework").locator(".account-paper-seat.is-lifted")).toHaveCount(1);
  await expect(target).toHaveClass(/drop-target/);
  await expect(target.locator(".settings-card")).not.toHaveCSS("box-shadow", "none");
  await expect(page.locator(".account-drop-slot.open")).toHaveCount(1);
  await expect(target.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "1");
  // The gap is a row tall, so the pointer comes to rest on the gap itself.
  await expect(target.locator(".account-drop-slot.open")).toHaveCSS("height", "62px");
  const gap = (await target.locator(".account-drop-slot.open").boundingBox())!;
  await page.mouse.move(gap.x + 200, gap.y + 20, { steps: 4 });
  await expect(target.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "1");

  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "POST", path: "/api/projects/inference/papers/miles/move",
    body: { project_id: "scaling-law", position: 1 },
  }]);
  await expect(target.locator(".account-paper-row").nth(1)).toContainText("Miles v0.1");
  await expect(group(page, "Inference Framework").locator(".account-project-count")).toHaveText("5");
  // The drop is not a click: the sheet is still here and nothing was opened.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(log(page)).toHaveText("");
  await expect(page.locator(".account-drop-slot")).toHaveCount(0);
});

test("the space between two projects belongs to the card above", async ({ page }) => {
  const state = await setup(page);
  await centre(page, "Test-Time Scaling Makes");
  // Mid-drag the gap between projects is the padding at the foot of the one above.
  await lift(page, "Miles v0.1", group(page, "Scaling Law"), box => ({ x: box.x + 200, y: box.y + box.height - 11 }));
  await expect(group(page, "Scaling Law")).toHaveClass(/drop-target/);
  await expect(group(page, "Scaling Law").locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "2");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "POST", path: "/api/projects/inference/papers/miles/move",
    body: { project_id: "scaling-law", position: 2 },
  }]);
});

test("a release the page never heard lands the paper where its gap opened, and the row stops following", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "how Chromium ends a capture it never saw released");
  const state = await setup(page);
  await lift(page, "vLLM-Omni", row(page, "Toward Recursive"), box => ({ x: box.x + 200, y: box.y + 8 }));
  await expect(page.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "0");
  const at = (await row(page, "Toward Recursive").boundingBox())!;
  await releaseUnheard(page, at.x + 200, at.y + 240);
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["vllm", "glm", "archs", "sglang", "knapformer", "miles"] },
  }]);
  await expect(page.locator(".account-paper-seat.is-lifted")).toHaveCount(0);
  await expect(page.locator(".account-drop-slot")).toHaveCount(0);
  await expect(log(page)).toHaveText("");
  await page.mouse.move(at.x + 200, at.y + 300, { steps: 4 });
  await expect(page.locator(".account-paper-seat.is-lifted")).toHaveCount(0);
  await page.mouse.up();
  expect(state.writes).toHaveLength(1);
  await expect(log(page)).toHaveText("");
  // No click follows a release nobody heard, so none is left to be swallowed.
  await row(page, "KnapFormer").click();
  await expect(log(page)).toHaveText("paper inference/knapformer");
});

test("dragging within a project reorders it, and its own place is no move", async ({ page }) => {
  const state = await setup(page);
  // Held over the seat it was lifted from, in either half: no gap, and letting
  // go changes nothing. SGLang is done and stored just above vLLM-Omni, so the
  // upper half is the one that used to save a reorder nobody could see.
  for (const offset of [-8, 8]) {
    // Aimed at the seat, which stays put; the lifted row follows the pointer.
    const seat = page.locator('.account-paper-seat[data-account-paper="vllm"]');
    await lift(page, "vLLM-Omni", seat, box => ({ x: box.x + 140, y: box.y + box.height / 2 + offset }));
    await expect(group(page, "Inference Framework")).toHaveClass(/drop-target/);
    await expect(page.locator(".account-drop-slot.open")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator(".account-drop-slot")).toHaveCount(0);
  }
  expect(state.writes).toEqual([]);
  // Let go, a row eases back to its seat rather than snapping there.
  await expect(row(page, "vLLM-Omni")).toHaveCSS("transition-property", /transform/);

  await lift(page, "vLLM-Omni", row(page, "Toward Recursive"), box => ({ x: box.x + 200, y: box.y + 8 }));
  await expect(page.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "0");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["vllm", "glm", "archs", "sglang", "knapformer", "miles"] },
  }]);
  await expect(group(page, "Inference Framework").locator(".account-paper-row").first()).toContainText("vLLM-Omni");
});

test("a reorder lands where its gap opened, whatever done papers sit between in stored order", async ({ page }) => {
  const state = await setup(page);
  // SGLang is done, so the card shows it last, but it is stored third: a gap
  // counted on the card is not an index into the stored order.
  await lift(page, "Toward Recursive", row(page, "Miles v0.1"), box => ({ x: box.x + 200, y: box.y + 8 }));
  await expect(page.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "4");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["archs", "sglang", "vllm", "knapformer", "glm", "miles"] },
  }]);
  await expect(group(page, "Inference Framework").locator(".account-paper-row strong")).toHaveText([
    /^Domain specific/, /^vLLM-Omni/, /^KnapFormer/, /^Toward Recursive/, /^Miles/, /^SGLang/,
  ]);
});

test("a paper filed into a project lands where its gap opened, above that project's done papers", async ({ page }) => {
  const state = await setup(page);
  const target = group(page, "Filing test (safe to delete)");
  await centre(page, "Early stopping");
  // Learning rate is done and stored between the two active papers; the gap
  // before it is the foot of the active ones.
  await lift(page, "慢即是快", row(page, "Learning rate"), box => ({ x: box.x + 200, y: box.y + 6 }));
  await expect(target.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "2");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "POST", path: "/api/projects/optimizers/papers/shampoo/move",
    body: { project_id: "filing", position: 3 },
  }]);
  await expect(target.locator(".account-paper-row strong")).toHaveText([
    /^Early stopping/, /^Ridge regression/, /^慢即是快/, /^Learning rate/,
  ]);
});

test("a project with no room takes no drop, done paper or not", async ({ page }) => {
  const state = await setup(page, "&max=2");
  for (const title of ["Miles v0.1", "SGLang"]) {
    await centre(page, "Test-Time Scaling Makes");
    await lift(page, title, row(page, "Scaling up Test-Time"), box => ({ x: box.x + 200, y: box.y + 6 }));
    await expect(page.locator(".account-paper-seat.is-lifted")).toHaveCount(1);
    await expect(page.locator(".drop-target")).toHaveCount(0);
    await page.mouse.up();
  }
  expect(state.writes).toEqual([]);
});

test("a project holding its total takes no drop, done paper or not", async ({ page }) => {
  const state = await setup(page, "&total=2");
  for (const title of ["Miles v0.1", "SGLang"]) {
    await centre(page, "Test-Time Scaling Makes");
    await lift(page, title, row(page, "Scaling up Test-Time"), box => ({ x: box.x + 200, y: box.y + 6 }));
    await expect(page.locator(".drop-target")).toHaveCount(0);
    await page.mouse.up();
  }
  expect(state.writes).toEqual([]);
});

test("no gap opens among done papers, and a done paper has no place to change in its own card", async ({ page }) => {
  const state = await setup(page);
  // The card held mid-pane, clear of the edges that autoscroll.
  const under = (box: Box) => ({ x: box.x + 200, y: box.y + box.height - 6 });
  // The last active paper, held under the done one: its only gap is its own seat.
  await centre(page, "KnapFormer");
  await lift(page, "Miles v0.1", row(page, "SGLang"), under);
  await expect(page.locator(".account-drop-slot.open")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".account-drop-slot")).toHaveCount(0);
  expect(state.writes).toEqual([]);

  // Any other paper held there lands above the done one.
  await centre(page, "KnapFormer");
  await lift(page, "Toward Recursive", row(page, "SGLang"), under);
  await expect(page.locator(".account-drop-slot.open")).toHaveAttribute("data-account-slot", "5");
  await page.mouse.up();
  await expect.poll(() => state.writes).toEqual([{
    method: "PUT", path: "/api/projects/inference/papers/order",
    body: { paper_ids: ["archs", "sglang", "vllm", "knapformer", "miles", "glm"] },
  }]);

  // The done paper itself, carried up its own card, opens nothing.
  await centre(page, "KnapFormer");
  await lift(page, "SGLang", row(page, "Domain specific archs"), box => ({ x: box.x + 200, y: box.y + 8 }));
  await expect(page.locator(".account-drop-slot.open")).toHaveCount(0);
  await expect(group(page, "Inference Framework")).not.toHaveClass(/drop-target/);
  await page.mouse.up();
  expect(state.writes).toHaveLength(1);
});
