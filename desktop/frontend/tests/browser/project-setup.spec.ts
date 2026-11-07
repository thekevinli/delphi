import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { freePort } from "../../../main/ports.ts";
import { startWorkerHost } from "../../../main/worker-host.ts";
import { DEFAULT_APP_CONFIG, type Project } from "../../app/lib/api.ts";
import { releaseUnheard } from "./unheard-release-fixture.ts";

// Keep Workspace mounted through project creation: remounting would discard
// its pending source and hide the cancellation regression.
let host: Awaited<ReturnType<typeof startWorkerHost>>;
let origin: string;
test.beforeAll(async () => {
  const port = await freePort("127.0.0.1");
  origin = `http://127.0.0.1:${port}`;
  host = await startWorkerHost({
    distDir: fileURLToPath(new URL("../../../.delphi-build/dist", import.meta.url)),
    backendUrl: "http://127.0.0.1:9",
    uiHost: "127.0.0.1", uiPort: port,
  });
});
test.afterAll(async () => {
  if (host) await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
});

async function mockReader(page: Page, projects: Project[] = []) {
  const sourceWrites: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/(papers|pages)$/.test(path)) sourceWrites.push(path);
    let value: unknown;
    switch (path) {
      case "/api/auth/me": value = { username: "reader", useStandardTier: true }; break;
      case "/api/config": value = { ...DEFAULT_APP_CONFIG, webDocumentsEnabled: true, memoryEnabled: false }; break;
      case "/api/onboarding/resolve": value = { onboarding: false }; break;
      case "/api/projects":
        if (request.method() === "POST") {
          const project: Project = {
            id: "project", slug: "later-project", name: request.postDataJSON().name,
            owner: "reader", updatedAt: "2026-10-01T12:00:00Z", paperCount: 0, papers: [],
          };
          projects.push(project);
          value = project;
        } else value = projects;
        break;
      case "/api/reader/reader/later-project": value = { project: projects[0], paperId: null }; break;
      case "/api/projects/project": value = projects[0]; break;
      case "/api/personas": value = { official: [], mine: [] }; break;
      case "/api/chat/conversations": value = { items: [], defaultId: null, limit: 10 }; break;
      default:
        await route.fulfill({ status: 404, json: { detail: "No fixture for this route" } });
        return;
    }
    await route.fulfill({ json: value });
  });
  return sourceWrites;
}

for (const source of ["pdf", "webpage"] as const) {
  for (const cancel of [true, false]) {
    test(`${cancel ? "cancel discards" : "creation retains"} a ${source} selected before a project exists`, async ({ page }) => {
      const sourceWrites = await mockReader(page);
      await page.goto(`${origin}/reader`);
      await expect(page.getByRole("button", { name: "New project", exact: true })).toBeVisible();
      if (source === "pdf") {
        await page.locator(".library-footer input[type=file]").setInputFiles({
          name: "Pending.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF"),
        });
      } else {
        await page.getByRole("button", { name: "Add a source", exact: true }).click();
        await page.getByRole("button", { name: "Webpage", exact: true }).click();
        await page.getByRole("textbox", { name: "Webpage address", exact: true }).fill("https://example.com/pending");
        await page.getByRole("button", { name: "Add", exact: true }).click();
      }
      const creation = page.getByRole("dialog", { name: "New project", exact: true });
      await expect(creation).toBeVisible();
      if (cancel) {
        await creation.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(creation).toHaveCount(0);
        await page.getByRole("button", { name: "New project", exact: true }).click();
      }
      await creation.getByRole("textbox", { name: "Project name", exact: true }).fill("Later project");
      await creation.getByRole("button", { name: "Create", exact: true }).click();
      const setup = page.getByRole("dialog", { name: "Add documents to Later project", exact: true });
      await expect(setup).toBeVisible();
      if (source === "pdf") {
        await setup.getByRole("button", { name: "Skip", exact: true }).click();
        await expect(setup.locator('[data-step="pdfs"]')).toHaveAttribute("data-state", "current");
        await expect(setup.locator('[data-step="pdfs"] .onboarding-file-name')).toHaveText(cancel ? [] : ["Pending.pdf"]);
      } else {
        await expect(setup.locator('[data-step="webpages"] .onboarding-file-name')).toHaveText(cancel ? [] : ["example.com"]);
      }
      expect(sourceWrites).toEqual([]);
    });
  }
}

test("bulk PDF setup keeps its question and actions in view at minimum window size", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await mockReader(page, [{
    id: "project", slug: "later-project", name: "Later project", owner: "reader",
    updatedAt: "2026-10-01T12:00:00Z", paperCount: 0, papers: [],
  }]);
  await page.goto(`${origin}/@reader/later-project?setup=1`);
  const setup = page.getByRole("dialog", { name: "Add documents to Later project", exact: true });
  await setup.getByRole("button", { name: "Skip", exact: true }).click();
  const pdfs = setup.locator('[data-step="pdfs"]');
  await expect(pdfs).toHaveAttribute("data-state", "current");
  await pdfs.locator('input[type="file"]').setInputFiles(Array.from({ length: 10 }, (_, index) => ({
    name: `Paper-${index + 1}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF"),
  })));
  await expect(pdfs.locator(".onboarding-file-name")).toHaveCount(10);
  // Wait for the step's entrance to finish before measuring clipping.
  await expect.poll(() => pdfs.evaluate(element => getComputedStyle(element).transform)).toBe("none");
  await page.screenshot({ path: testInfo.outputPath("bulk-pdf-setup.png") });
  await expect(pdfs.getByRole("heading", { name: "Add any PDF", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(pdfs.locator(".onboarding-help")).toBeInViewport({ ratio: 1 });
  await expect(pdfs.getByRole("button", { name: "Continue", exact: true })).toBeInViewport({ ratio: 1 });
  // Scrolling the chosen files must not displace the question or its action.
  const files = pdfs.locator(".onboarding-files");
  await files.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(pdfs.getByRole("button", { name: "Remove Paper-10.pdf", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(pdfs.getByRole("heading", { name: "Add any PDF", exact: true })).toBeInViewport({ ratio: 1 });
  await pdfs.getByRole("button", { name: "Continue", exact: true }).click();
  const review = setup.locator('[data-step="filing"]');
  await expect(review).toHaveAttribute("data-state", "current");
  await expect(review.getByRole("heading", { name: "Memory filing", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(review.getByRole("button", { name: "Start reading", exact: true })).toBeInViewport({ ratio: 1 });
});

for (const chat of [false, true]) {
  test(`library expansion preserves reader space with ${chat ? "chat" : "Memory"}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 700 });
    const project: Project = {
      id: "project", slug: "later-project", name: "Later project", owner: "reader",
      updatedAt: "2026-10-01T12:00:00Z", paperCount: 1,
      papers: [{ id: "paper", slug: "document", title: "Document", filename: "document.pdf", pages: 1, tokens: 1 }],
    };
    await mockReader(page, [project]);
    await page.route("**/api/reader/reader/later-project/document", route => route.fulfill({ json: { project, paperId: "paper" } }));
    await page.goto(`${origin}/@reader/later-project/document${chat ? "?chat=project" : ""}`);
    const divider = page.getByRole("separator", { name: "Resize paper library" });
    const libraryWidth = () => page.locator(".library-panel").evaluate(el => Math.round(el.getBoundingClientRect().width));
    await divider.press("End");
    await expect.poll(libraryWidth).toBe(480);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole("button", { name: "Expand library", exact: true }).click();
    await expect.poll(libraryWidth).toBe(chat ? 140 : 268);
    await expect.poll(() => page.locator(".reader-panel").evaluate(el => Math.round(el.getBoundingClientRect().width))).toBeGreaterThanOrEqual(372);
    // A larger window restores the preference; a divider drag uses the visible width.
    await page.setViewportSize({ width: 1600, height: 700 });
    await expect.poll(libraryWidth).toBe(480);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole("button", { name: "Expand library", exact: true }).click();
    await expect.poll(libraryWidth).toBe(chat ? 140 : 268);
    await divider.press("End");
    await expect.poll(libraryWidth).toBe(chat ? 140 : 268);
    await expect(page.locator(".library-scrim")).toHaveCount(0);
  });
}

test("a divider let go where the page never heard it keeps the width it was let go at", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "how Chromium ends a capture it never saw released");
  await page.setViewportSize({ width: 1400, height: 800 });
  const project: Project = {
    id: "project", slug: "later-project", name: "Later project", owner: "reader",
    updatedAt: "2026-10-01T12:00:00Z", paperCount: 1,
    papers: [{ id: "paper", slug: "document", title: "Document", filename: "document.pdf", pages: 1, tokens: 1 }],
  };
  await mockReader(page, [project]);
  await page.route("**/api/reader/reader/later-project/document", route => route.fulfill({ json: { project, paperId: "paper" } }));
  await page.goto(`${origin}/@reader/later-project/document`);
  const divider = page.getByRole("separator", { name: "Resize paper library" });
  const panels = page.locator(".three-panel");
  const libraryWidth = () => page.locator(".library-panel").evaluate(el => Math.round(el.getBoundingClientRect().width));
  await expect(divider).toBeVisible();
  const start = Number(await divider.getAttribute("aria-valuenow"));
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await expect(panels).toHaveClass(/is-panel-resizing/);
  await expect.poll(libraryWidth).toBe(start + 60);
  // Let go at +60; the hand has gone on to +120 by the time the page knows.
  await releaseUnheard(page, x + 120, y);
  await expect(panels).not.toHaveClass(/is-panel-resizing/);
  // The panels take the pointer again: no resize cursor, and the reader clicks.
  await expect(page.locator(".reader-panel")).toHaveCSS("pointer-events", "auto");
  await expect(divider).toHaveAttribute("aria-valuenow", String(start + 60));
  // The edge stays where it was let go however far the pointer travels after.
  await page.mouse.move(x + 160, y, { steps: 4 });
  await page.waitForTimeout(100);
  expect(await libraryWidth()).toBe(start + 60);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", String(start + 60));
});

test("a divider that never held the pointer still follows it and stops where it is let go", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const project: Project = {
    id: "project", slug: "later-project", name: "Later project", owner: "reader",
    updatedAt: "2026-10-01T12:00:00Z", paperCount: 1,
    papers: [{ id: "paper", slug: "document", title: "Document", filename: "document.pdf", pages: 1, tokens: 1 }],
  };
  await mockReader(page, [project]);
  await page.route("**/api/reader/reader/later-project/document", route => route.fulfill({ json: { project, paperId: "paper" } }));
  await page.goto(`${origin}/@reader/later-project/document`);
  const divider = page.getByRole("separator", { name: "Resize paper library" });
  await expect(divider).toBeVisible();
  // The panels take no pointer while a resize runs, so without the capture
  // the moves and the release land on the grid around them, never the divider.
  await page.evaluate(() => { Element.prototype.setPointerCapture = () => undefined; });
  const start = Number(await divider.getAttribute("aria-valuenow"));
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".three-panel")).not.toHaveClass(/is-panel-resizing/);
  await expect(divider).toHaveAttribute("aria-valuenow", String(start + 60));
});

for (const hold of [true, false]) {
test(`a ${hold ? "held" : "moving"} mouse press drags a library document to a new place`, async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const paper = (n: number) => ({ id: `paper-${n}`, slug: `document-${n}`, title: `Document ${n}`, filename: `document-${n}.pdf`, pages: 1, tokens: 1 });
  const project: Project = {
    id: "project", slug: "later-project", name: "Later project", owner: "reader",
    updatedAt: "2026-10-01T12:00:00Z", paperCount: 3, papers: [paper(1), paper(2), paper(3)],
  };
  await mockReader(page, [project]);
  let order: string[] | null = null;
  await page.route("**/api/projects/project/papers/order", route => {
    order = route.request().postDataJSON().paper_ids;
    project.papers = order!.map(id => project.papers.find(item => item.id === id)!);
    return route.fulfill({ json: project });
  });
  await page.route("**/api/reader/reader/later-project/document-1", route => route.fulfill({ json: { project, paperId: "paper-1" } }));
  await page.goto(`${origin}/@reader/later-project/document-1`);
  const rows = page.locator(".paper-row");
  await expect(rows).toHaveCount(3);
  const from = (await rows.nth(0).locator(".paper-row-main").boundingBox())!;
  const to = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  // The hold lifts the row on its own after a moment, so "a short move has not
  // lifted it yet" is only true while that moment has not passed. Stop the
  // page's clock for the claim rather than racing it on a busy machine.
  if (!hold) await page.clock.pauseAt(Date.now() + 1000);
  await page.mouse.down();
  // A mouse needs no hold: the row lifts once the press has travelled.
  if (hold) await expect(rows.nth(0)).toHaveClass(/is-lifted/);
  else {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 5);
    await expect(rows.nth(0)).not.toHaveClass(/is-lifted/);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12);
    await expect(rows.nth(0)).toHaveClass(/is-lifted/);
    await page.clock.resume();
  }
  await page.mouse.move(from.x + from.width / 2, to.y + to.height - 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => order).toEqual(["paper-2", "paper-3", "paper-1"]);
  await expect(rows.locator(".paper-row-main strong, .paper-row-main .paper-title").first()).toContainText("Document 2");
  // The drop is not replayed as a click onto the document that moved.
  await expect(page).toHaveURL(/document-1$/);
});
}

test("a failure in the reader stays until it is dismissed", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const paper = (n: number) => ({ id: `paper-${n}`, slug: `document-${n}`, title: `Document ${n}`, filename: `document-${n}.pdf`, pages: 1, tokens: 1 });
  const project: Project = {
    id: "project", slug: "later-project", name: "Later project", owner: "reader",
    updatedAt: "2026-10-01T12:00:00Z", paperCount: 2, papers: [paper(1), paper(2)],
  };
  await mockReader(page, [project]);
  await page.route("**/api/projects/project/papers/order", route => route.fulfill({ status: 500, json: { detail: "The library could not be saved." } }));
  await page.route("**/api/reader/reader/later-project/document-1", route => route.fulfill({ json: { project, paperId: "paper-1" } }));
  await page.goto(`${origin}/@reader/later-project/document-1`);
  const rows = page.locator(".paper-row");
  const from = (await rows.nth(0).locator(".paper-row-main").boundingBox())!;
  const to = (await rows.nth(1).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height - 4, { steps: 8 });
  await page.mouse.up();
  const failure = page.locator(".toast-error");
  await expect(failure).toBeVisible();
  // Longer than any hint lives: an error unread has not been reported.
  await page.waitForTimeout(6500);
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(failure).toHaveCount(0);
});
