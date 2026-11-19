import { expect, test } from "@playwright/test";

test("every settled filing card is the running card's chrome with one notice-sized verb", async ({ page }) => {
  await page.goto("/tests/browser/harness.html?filing");
  for (const name of ["one-page", "several-pages", "older-delphi", "gave-up", "gave-up-with-page", "no-page", "not-filed"]) {
    const card = page.getByTestId(name).locator(".filing-progress");
    await expect(card).toBeVisible();
    const button = card.getByRole("button");
    await expect(button).toHaveCount(1);
    const box = await button.boundingBox();
    expect(box!.height).toBe(28);
    expect(await button.evaluate(node => getComputedStyle(node).borderRadius)).toBe("6px");
  }
  const several = page.getByTestId("several-pages");
  await expect(several.locator(".filing-progress-pages li")).toHaveCount(2);
  await expect(several.getByText("Cites a figure the document does not have.")).toBeVisible();
  // A page can be dropped while writing as well as at the check, so no step is named.
  await expect(several.locator(".filing-progress-segments")).toHaveCount(0);
  // A verb that fixes a failure is primary; an optional one is secondary.
  await expect(page.getByTestId("gave-up").locator(".primary-button")).toHaveText("Try again");
  // A first filing that gave up after its digest still has its page, and still says so.
  await expect(page.getByTestId("gave-up-with-page").locator(".primary-button")).toHaveText("Try again");
  await expect(page.getByTestId("gave-up-with-page").getByText("Only its own page is in Memory so far")).toBeVisible();
  await expect(page.getByTestId("older-delphi").locator(".secondary-button")).toHaveText("Update document");
  await page.screenshot({ path: test.info().outputPath("filing.png"), fullPage: true });
});
