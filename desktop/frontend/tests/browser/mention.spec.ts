import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  await page.goto(`/tests/browser/harness.html?mention${query}`);
  const field = page.getByRole("textbox", { name: "Ask anything" });
  await field.click();
  await page.keyboard.type("Compare with @");
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  return { field, menu };
}
const option = (page: Page, index: number) => page.getByRole("option").nth(index);

test("the @ menu is plain text tabs over rows wearing the file marks", async ({ page }) => {
  const { menu } = await open(page);
  expect((await menu.boundingBox())!.width).toBe(420);

  // Tabs are words with a number after them: no pill, no badge.
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(["Documents6", "Images2"]);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(tabs.nth(0).locator(".mention-tab-count")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(tabs.nth(0)).toHaveCSS("color", "rgb(36, 20, 18)");
  await expect(tabs.nth(1)).toHaveCSS("color", "rgb(140, 117, 110)");

  // The first row is the one Enter takes, and it alone says so.
  await expect(page.getByRole("option")).toHaveCount(6);
  await expect(option(page, 0)).toHaveAttribute("aria-selected", "true");
  await expect(option(page, 0)).toHaveCSS("background-color", "rgb(251, 244, 242)");
  await expect(option(page, 0)).toHaveCSS("height", "34px");
  await expect(page.locator(".mention-return")).toHaveCount(1);
  await expect(option(page, 0).locator(".mention-return")).toBeVisible();

  // The marks follow the stored kind; a linked PDF is a PDF.
  await expect(option(page, 0).getByRole("img", { name: "PDF" })).toBeVisible();
  await expect(option(page, 1).getByRole("img", { name: "Web page" })).toBeVisible();
  await expect(option(page, 5).getByRole("img", { name: "PDF" })).toBeVisible();
  // One line, however long the title.
  const long = (await option(page, 5).boundingBox())!;
  expect(long.height).toBe(34);
});

test("keys and pointer move one highlight, and Enter takes it", async ({ page }) => {
  const { field } = await open(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(option(page, 2)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mention-return")).toHaveCount(1);

  // The pointer moves the same highlight rather than adding a second one.
  await option(page, 4).hover();
  await expect(option(page, 4)).toHaveAttribute("aria-selected", "true");
  await expect(option(page, 2)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("ArrowUp");
  await expect(option(page, 3)).toHaveAttribute("aria-selected", "true");

  // Typing filters; the count on the tab follows.
  await page.keyboard.type("dist");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("tab").nth(0)).toHaveText("Documents2");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByTestId("picked")).toHaveText("opd");
  await expect(field.locator("mark")).toHaveText("@On-Policy Distillation");

  // Escape closes the menu without sending the question.
  await page.keyboard.type("and @");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByTestId("picked")).toHaveText("opd");
  // That `@` stays dismissed while typing goes on, so Enter sends.
  await page.keyboard.type("dist");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picked")).toHaveText("opd,submit");
  // Leaving that `@` and typing a new one opens the menu again.
  await page.keyboard.type(" @");
  await expect(page.getByRole("listbox")).toBeVisible();
});

test("the Images tab lists thumbnails and a quiet expiry note", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option")).toHaveText(["Image #1↵", "Image #2Expires in 2 days"]);
  await expect(option(page, 0)).toHaveCSS("height", "38px");
  await expect(option(page, 0).locator("img")).toHaveCSS("width", "28px");
  await expect(option(page, 0).locator("img")).toHaveCSS("height", "20px");
  await expect(option(page, 1).locator(".mention-note")).toHaveCSS("color", "rgb(140, 117, 110)");
  await page.getByRole("option").nth(1).click();
  await expect(page.getByTestId("picked")).toHaveText("image-2");
  await expect(page.getByTestId("draft")).toHaveText("Compare with @[Image #2] ");
});

test("an empty tab says what would fill it", async ({ page }) => {
  await open(page, "&empty&no-images");
  await expect(page.locator(".mention-empty")).toHaveText("No other documents hereAdd one to this project to mention it.");
  await expect(page.getByRole("tab")).toHaveText(["Documents0", "Images0"]);
  await page.getByRole("tab", { name: /Images/ }).click();
  await expect(page.locator(".mention-empty")).toHaveText("No images in this chatPaste or attach one to mention it.");
  // Enter with nothing to take is still the reader's Enter.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picked")).toHaveText("submit");
});

test("a scope with only images shows no tab strip", async ({ page }) => {
  await open(page, "&general");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(2);
});
