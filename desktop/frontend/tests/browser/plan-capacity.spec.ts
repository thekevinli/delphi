import { test, expect, type Page } from "@playwright/test";

// Plan storage is full: three saved plans, the limit three.
async function setup(page: Page) {
  await page.route("**/desktop/plans/capacity", route => route.fulfill({ json: {
    limit: 3, pending: 0,
    plans: [1, 2, 3].map(n => ({ id: `plan-${n}-0000`, title: `Plan ${n}`, revision: 1 })),
  } }));
  await page.goto("/tests/browser/harness.html?capacity");
}
const result = (page: Page) => page.getByTestId("result");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Make room for your plan" });

test("a full plan store asks the reader, and cancelling answers no", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Fixture ask", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(result(page)).toHaveText("waiting");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(result(page)).toHaveText("false");
  await expect(dialog(page)).toHaveCount(0);
});

test("a panel that was replaced answers no at once instead of waiting on a dialog nobody sees", async ({ page }) => {
  // Astra's reproduction: the conversation was created, the panel remounted,
  // and the send's retry asked the old panel — which could never answer, so
  // the chat stayed "answering" for good.
  await setup(page);
  await page.getByRole("button", { name: "Fixture remount" }).click();
  await page.getByRole("button", { name: "Fixture ask old panel" }).click();
  await expect(result(page)).toHaveText("false");
  await expect(dialog(page)).toHaveCount(0);
  // The panel now on screen can still ask.
  await page.getByRole("button", { name: "Fixture ask", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
});

test("Stop ends a capacity check that is waiting on the reader", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Fixture ask", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  // The dialog is modal, so this is the send's own abort signal (as Stop
  // sends it) rather than a click that would have to reach through it.
  await page.getByRole("button", { name: "Fixture stop" }).dispatchEvent("click");
  await expect(result(page)).toHaveText("false");
  await expect(dialog(page)).toHaveCount(0);
});
