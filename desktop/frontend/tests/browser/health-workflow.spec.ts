import { expect, test, type Page } from "@playwright/test";
import { healthWorkspace, type HealthWorkspace } from "../../../tests/fixtures/health-workspace.mts";

// Health against the installed backend: its queue, retries, cancel and backfill
// are real; only the model provider is a fixture, refusing every call.
let workspace: HealthWorkspace | undefined;
test.afterEach(async ({}, info) => {
  if (workspace && info.status !== info.expectedStatus) await info.attach("backend-log", { body: workspace.logs(), contentType: "text/plain" });
  await workspace?.close();
  workspace = undefined;
});

async function openHealth(page: Page) {
  const [name, value] = workspace!.cookie.split("=");
  await page.context().addCookies([{ name: name!, value: value!, url: workspace!.origin }]);
  await page.goto(`${workspace!.origin}/memory/health`);
}
const foot = (page: Page) => page.locator(".kb-memory-rail .kb-health-status");
const gaveUp = async () => (await workspace!.queue()).jobs.filter((job) => job.status === "failed" && !job.retryAt).length;

test("a filing that fails with tries left reads as Filing; Stop calls it off and File offers it again", async ({ page }) => {
  test.setTimeout(120_000);
  const w = (workspace = await healthWorkspace());
  await w.addPaper(await w.project("Scaling"), "Attention is all you need");
  await openHealth(page);

  // The window drains the queue itself; the refused call leaves the job
  // waiting out its first backoff.
  await expect.poll(async () => (await w.queue()).jobs[0]?.status, { timeout: 60_000 }).toBe("failed");
  expect((await w.queue()).jobs[0]!.retryAt).not.toBeNull();
  await expect(foot(page).locator(".kb-health-status-button")).toHaveText(/Filing\s*1/);
  await expect(foot(page).getByRole("button", { name: "Memory unhealthy" })).toHaveCount(0);

  await foot(page).getByRole("button", { name: "Stop filing", exact: true }).click();
  await expect.poll(async () => (await w.queue()).jobs.length).toBe(0);
  const file = foot(page).getByRole("button", { name: "File 1 document", exact: true });
  await expect(file.locator(".kb-health-status-number")).toHaveText("1");

  const before = w.calls.length;
  await file.click();
  await expect(foot(page).locator(".kb-health-status-button")).toHaveText(/Filing/);
  await expect.poll(async () => (await w.queue()).jobs.length).toBe(1);
  await expect.poll(() => w.calls.length, { timeout: 60_000 }).toBeGreaterThan(before);
});

test("filings that give up make Memory unhealthy, say why under Stuck, and Try again runs one again", async ({ page }) => {
  test.setTimeout(120_000);
  // One try, so giving up takes seconds rather than the backoff's half hour.
  const w = (workspace = await healthWorkspace({ maxAttempts: 1 }));
  const projectId = await w.project("Optimizers");
  await w.addPaper(projectId, "Muon");
  await w.addPaper(projectId, "Adam");
  await openHealth(page);

  await expect.poll(gaveUp, { timeout: 90_000 }).toBe(2);
  const status = foot(page).getByRole("button", { name: "Memory unhealthy", exact: true });
  await expect(status).toBeVisible();
  // Stuck owns both documents, so File does not offer them a second time.
  await expect(foot(page).getByRole("button", { name: /^File/ })).toHaveCount(0);

  await status.click();
  const panel = page.getByRole("region", { name: "Why Memory is unhealthy" });
  await expect(panel.locator(".kb-health-status-row")).toHaveText(["Stuck2"]);
  await panel.getByRole("button", { name: /^Stuck/ }).click();
  const stuck = page.getByRole("region", { name: "Stuck" });
  await expect(stuck).toContainText("2 jobs gave up");
  const rows = stuck.locator(".kb-health-row");
  await expect(rows).toHaveCount(2);
  await expect(stuck).toContainText("Muon");
  await expect(stuck).toContainText("Adam");
  await expect(rows.first()).toContainText(/Gave up after 1 try · last try today at \d\d:\d\d/);
  await expect(rows.first()).toContainText("Provider unavailable. Busy, down or past your plan’s limit.");
  await rows.first().getByRole("button", { name: "Technical detail", exact: true }).click();
  await expect(stuck.locator(".kb-health-detail")).toContainText("429 Too Many Requests");

  // Try again puts the job back and the window runs it; under the same
  // provider it gives up again, and stays listed rather than vanishing.
  const ids = (await w.queue()).jobs.map((job) => job.id).sort();
  const before = w.calls.length;
  await rows.first().getByRole("button", { name: /^Try again: / }).click();
  await expect.poll(() => w.calls.length, { timeout: 60_000 }).toBeGreaterThan(before);
  await expect.poll(gaveUp, { timeout: 60_000 }).toBe(2);
  expect((await w.queue()).jobs.map((job) => job.id).sort()).toEqual(ids);
  await expect(stuck).toContainText("2 jobs gave up");
});

const runCard = (page: Page) => page.locator(".kb-operation-notice-layer .kb-backfill");

test("a run whose filings give up lists them under their cause, and the cause's Try again files them again", async ({ page }) => {
  test.setTimeout(150_000);
  const w = (workspace = await healthWorkspace({ maxAttempts: 1 }));
  const projectId = await w.project("Optimizers");
  await w.addPaper(projectId, "Muon");
  await w.addPaper(projectId, "Adam");
  await openHealth(page);

  await expect.poll(gaveUp, { timeout: 90_000 }).toBe(2);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("2 documents failed");
  await expect(card.locator(".kb-backfill-detail")).toHaveText("Your Memory was not changed.");
  // The server named the cause from the refusal itself: one group, both documents.
  const busy = card.getByRole("region", { name: "Provider unavailable" });
  await expect(card.locator(".kb-run-group")).toHaveCount(1);
  await expect(busy.locator(".kb-run-group-line")).toHaveText("Busy, down or past your plan’s limit.");
  await expect(busy.locator(".kb-run-document strong")).toHaveText(["Muon", "Adam"]);
  // One cause, so no Try all: its own verb says it.
  await expect(card.getByRole("button", { name: /^Try all/ })).toHaveCount(0);
  await busy.locator(".kb-run-document").first().getByRole("button", { name: "Technical detail", exact: true }).click();
  await expect(busy.locator(".kb-health-detail")).toContainText("429 Too Many Requests");

  const ids = (await w.queue()).jobs.map((job) => job.id).sort();
  const before = w.calls.length;
  await busy.getByRole("button", { name: "Try again: Provider unavailable", exact: true }).click();
  // Both go back in line and are filed again, under the same provider, which
  // refuses them again: the card follows them there and back.
  await expect.poll(() => w.calls.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(before + 2);
  await expect.poll(gaveUp, { timeout: 60_000 }).toBe(2);
  expect((await w.queue()).jobs.map((job) => job.id).sort()).toEqual(ids);
  await expect(card.locator(".kb-backfill-title")).toHaveText("2 documents failed");
  await expect(busy.locator(".kb-run-document strong")).toHaveText(["Muon", "Adam"]);
});

test("a key the provider refuses is a sign-in to fix, not a filing to try again", async ({ page }) => {
  test.setTimeout(120_000);
  const w = (workspace = await healthWorkspace({ maxAttempts: 1, status: 401 }));
  await w.addPaper(await w.project("Attention"), "Flash attention");
  await openHealth(page);

  await expect.poll(gaveUp, { timeout: 90_000 }).toBe(1);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("1 document failed");
  const signin = card.getByRole("region", { name: "Sign-in refused" });
  await expect(signin.locator(".kb-run-group-line")).toHaveText("Reconnect your AI provider.");
  await expect(signin).toContainText("Flash attention");
  await expect(signin.getByRole("button", { name: /^Try again/ })).toHaveCount(0);
  await signin.getByRole("button", { name: "Open AI connection", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "Advanced" })).toBeVisible();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();

  // Health names it the same way.
  await foot(page).getByRole("button", { name: "Memory unhealthy", exact: true }).click();
  await page.getByRole("region", { name: "Why Memory is unhealthy" }).getByRole("button", { name: /^Stuck/ }).click();
  await expect(page.getByRole("region", { name: "Stuck" })).toContainText("Sign-in refused. Reconnect your AI provider.");
});
