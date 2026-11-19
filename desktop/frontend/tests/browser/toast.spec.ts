import { expect, test } from "@playwright/test";

test("a hint sent again is shown afresh, with its whole life ahead of it", async ({ page }) => {
  await page.goto("/tests/browser/harness.html?toast");
  const send = page.getByRole("button", { name: "Fixture hint", exact: true });
  const toast = page.locator(".toast-hint");
  const age = () => toast.evaluate(node => Number(node.getAnimations().find(animation => (animation as CSSAnimation).animationName === "toast-hint-life")!.currentTime));
  await send.click();
  await expect(toast).toHaveText("Saved to the library.");
  await expect.poll(age).toBeGreaterThan(600);
  await send.click();
  expect(await age()).toBeLessThan(400);
  // Pressing it still dismisses it.
  await toast.click();
  await expect(toast).toHaveCount(0);
});
