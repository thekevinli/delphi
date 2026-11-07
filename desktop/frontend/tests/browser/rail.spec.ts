import { test, expect, type Page } from "@playwright/test";

const A = "a".repeat(32), B = "b".repeat(32);
const item = (id: string, title: string, createdAt: string) => ({
  id, generation: 0, title, empty: false, kind: "project_chat", projectId: "project", paperId: null,
  createdAt, lastEngagedAt: createdAt, personaId: null, lastChatModel: null, manualTitle: false,
});

async function setup(page: Page, delayMs = 0) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/chat/conversations")) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return route.fulfill({ json: { items: [item(A, "Chat A", "2026-09-24T10:00:00Z"), item(B, "Chat B", "2026-09-24T11:00:00Z")], defaultId: A, limit: 10 } });
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected test request ${url.pathname}` } });
  });
}
const open = (page: Page) => page.getByTestId("open");
const address = (page: Page) => page.evaluate(() => new URL(location.href).searchParams.get("conversation"));

test("a chat handed off from the composer is the one a reload reopens", async ({ page }) => {
  await setup(page);
  await page.goto("/tests/browser/harness.html?rail");
  await expect(open(page)).toHaveText(A);
  // The reader's own pick is remembered.
  await page.getByRole("tab", { name: /Chat B/ }).click();
  await expect(open(page)).toHaveText(B);
  await page.getByRole("tab", { name: /Chat A/ }).click();
  await expect(open(page)).toHaveText(A);
  // The composer hands over B. It opens — and the address and this tab's
  // memory follow, so a reload does not fall back to A.
  await page.getByRole("button", { name: "Fixture hand off B" }).click();
  await expect(open(page)).toHaveText(B);
  await expect.poll(() => address(page)).toBe(B);
  await page.goto("/tests/browser/harness.html?rail");
  await expect(open(page)).toHaveText(B);
});

test("a deep link outranks what the tab remembered, and survives the catalog read", async ({ page }) => {
  await setup(page, 400);
  await page.goto("/tests/browser/harness.html?rail");
  await expect(open(page)).toHaveText(A);
  await page.goto(`/tests/browser/harness.html?rail&conversation=${B}`);
  // Nothing has been chosen while the catalog is in flight, so nothing may
  // rewrite the address the reader arrived with.
  expect(await address(page)).toBe(B);
  await expect(open(page)).toHaveText(B);
  expect(await address(page)).toBe(B);
});

test("context switches ignore the departing conversation and restore each context's selection", async ({ page }) => {
  await page.route("**/api/chat/conversations?**", route => {
    const scope = new URL(route.request().url()).searchParams.get("scope");
    const items = scope === "document" ? [item(A, "Document chat", "2026-09-24T10:00:00Z")]
      : scope === "general" ? [item(B, "Memory chat", "2026-09-24T10:00:00Z")] : [];
    return route.fulfill({ json: { items, defaultId: items[0]?.id ?? null, limit: 10 } });
  });
  await page.goto(`/tests/browser/harness.html?rail&chat=paper&conversation=${A}`);
  await expect(open(page)).toHaveText(A);
  for (const [context, expected] of [["general", B], ["document", A], ["general", B]]) {
    await page.getByRole("button", { name: `Fixture ${context}`, exact: true }).click();
    await expect(open(page)).toHaveText(expected);
    await expect(page.getByTestId("notice")).toBeEmpty();
    await expect.poll(() => address(page)).toBe(expected === "provisional" ? null : expected);
  }
});

test("a missing conversation in an explicit deep link still shows a notice", async ({ page }) => {
  await setup(page);
  await page.goto(`/tests/browser/harness.html?rail&conversation=${"c".repeat(32)}`);
  await expect(open(page)).toHaveText(A);
  await expect(page.getByTestId("notice")).toHaveText("That conversation is no longer available.");
});
