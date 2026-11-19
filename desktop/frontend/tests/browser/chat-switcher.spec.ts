import { expect, test, type Page } from "@playwright/test";

// The reader's chat header: one title that drops this document's chats, and
// "+", across the rail's widths; and the Memory page's list of its chats.
const hour = 3600_000;
const today = new Date();
const daysAgo = (days: number, hours = 0) => new Date(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days, 12).getTime() - hours * hour).toISOString();
const DOCUMENT = [
  { title: "Who Are vLLM-Omni’s Core Contributors?", at: new Date(Date.now() - 2 * 60_000).toISOString() },
  { title: "vLLM-Omni’s Multi-Stage Design", at: new Date(Date.now() - 3 * hour).toISOString() },
  { title: "A Minimal Streaming Runtime", at: daysAgo(2) },
  { title: "Chinchilla and MoE scaling laws compared across seven papers of the reading list", at: daysAgo(12) },
];
const MEMORY = [
  { title: "What do I know about speculative decoding?", at: new Date(Date.now() - 20 * 60_000).toISOString() },
  { title: "KV cache strategies across my papers", at: daysAgo(3) },
  { title: "Reading order for diffusion", at: daysAgo(20) },
];
const idOf = (scope: string, index: number) => (scope === "general" ? "e" : "d") + String(index).repeat(31);

async function serve(page: Page) {
  const deleted: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") === "general" ? "general" : "document";
    const items = (scope === "general" ? MEMORY : DOCUMENT)
      .map(({ title, at }, index) => ({ id: idOf(scope, index), generation: 0, title, empty: false, createdAt: at, lastEngagedAt: at }))
      .filter(item => !deleted.includes(item.id));
    if (url.pathname.endsWith("/chat/conversations")) return route.fulfill({ json: { items, defaultId: items[0]?.id ?? null, limit: scope === "general" ? 50 : 10 } });
    if (url.pathname.endsWith("/chat") && route.request().method() === "DELETE") {
      deleted.push(url.searchParams.get("conversation_id")!);
      const rest = items.filter(item => !deleted.includes(item.id));
      return route.fulfill({ json: { selectedId: rest[0].id, catalog: { items: rest, defaultId: rest[0].id, limit: 10 } } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  return deleted;
}
async function openChat(page: Page, width = 460) {
  await serve(page);
  await page.goto(`/tests/browser/harness.html?responsive-chat&closable&width=${width}`);
  await expect(trigger(page)).toBeVisible();
}
const header = (page: Page) => page.locator(".conversation-header");
const trigger = (page: Page) => header(page).locator(".conversation-switch-trigger");
const sheet = (page: Page) => page.getByRole("menu", { name: "Chats on this document" });
const address = (page: Page) => page.evaluate(() => new URL(location.href).searchParams.get("conversation"));

for (const width of [320, 460, 600]) {
  test(`at ${width}px the header is the chat's title, then +, Expand and Hide, none overlapping`, async ({ page }) => {
    await openChat(page, width);
    await expect(trigger(page)).toHaveText(DOCUMENT[0].title);
    const boxes = await header(page).evaluate(node => {
      const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
      return { header: node.getBoundingClientRect().toJSON() as DOMRect, title: box(".conversation-switch-trigger"), add: box(".conversation-new"), controls: box(".conversation-window-controls") };
    });
    expect(boxes.title.left).toBeGreaterThanOrEqual(boxes.header.left);
    expect(boxes.title.right).toBeLessThanOrEqual(boxes.add.left);
    expect(boxes.add.right).toBeLessThanOrEqual(boxes.controls.left);
    expect(boxes.controls.right).toBeLessThanOrEqual(boxes.header.right);
    expect(boxes.add.width).toBe(24);
    expect(boxes.header.height).toBe(40);
    // No count, no shortcut hint: the title is the only text.
    await expect(header(page)).not.toContainText(/chats|⌃/i);
    // Chat, the default, is not drawn at any width.
    await expect(page.locator(".composer-mode-tag")).toHaveCount(0);
  });
}

test("the chevron and + are equally quiet, and the sheet is flush, not a rounded popover", async ({ page }) => {
  await openChat(page);
  const ink = (selector: string) => header(page).locator(selector).evaluate(node => getComputedStyle(node).color);
  expect(await ink(".conversation-chevron")).toBe(await ink(".conversation-new"));
  await trigger(page).click();
  await expect(sheet(page)).toBeVisible();
  const radius = await sheet(page).evaluate(node => parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0);
  expect(radius).toBeLessThanOrEqual(6);
  const [card, drop] = await Promise.all([page.locator(".chat-surface").boundingBox(), sheet(page).boundingBox()]);
  expect(Math.abs(drop!.width - card!.width)).toBeLessThanOrEqual(2);
});

test("two clicks switch chats: the title, then a chat", async ({ page }) => {
  await openChat(page);
  await trigger(page).click();
  const rows = sheet(page).locator(".conversation-row > button:first-child");
  await expect(rows).toHaveCount(DOCUMENT.length);
  // Newest first, the open one marked.
  await expect(rows.first()).toContainText(DOCUMENT[0].title);
  await expect(rows.first()).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(1)).toContainText("3h");
  await rows.nth(2).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(trigger(page)).toHaveText(DOCUMENT[2].title);
  await expect.poll(() => address(page)).toBe(idOf("document", 2));
  // A click away closes the sheet with nothing changed.
  await trigger(page).click();
  await page.locator(".conversation-sheet-veil").click({ position: { x: 10, y: 300 } });
  await expect(sheet(page)).toHaveCount(0);
  await expect(trigger(page)).toHaveText(DOCUMENT[2].title);
});

test("the keyboard opens the sheet, walks its rows and gives focus back", async ({ page }) => {
  await openChat(page);
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(sheet(page)).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.closest(".conversation-row")?.getAttribute("data-conversation"));
  await expect.poll(focused).toBe(idOf("document", 0));
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe(idOf("document", 1));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(focused).toBe(idOf("document", 3));
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  // Tab leaves the sheet for its title too.
  await page.keyboard.press("ArrowDown");
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(sheet(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  // Escape inside the chat closes only the sheet, never the chat itself.
  await expect(page.locator(".chat-surface")).toBeVisible();
});

test("a row's ⋮ offers Rename and Delete in its place, and Delete asks first", async ({ page }) => {
  await openChat(page);
  await trigger(page).click();
  const row = sheet(page).locator(".conversation-row", { hasText: DOCUMENT[1].title });
  await row.hover();
  const more = row.getByRole("menuitem", { name: `Options for ${DOCUMENT[1].title}` });
  await more.click();
  await expect(row.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  // Escape puts the ⋮ back with the keyboard on it, and the sheet stays open.
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(sheet(page)).toBeVisible();
  await more.click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation" });
  await dialog.getByRole("button", { name: "Delete chat" }).click();
  await expect(dialog).toHaveCount(0);
  await trigger(page).click();
  await expect(sheet(page).locator(".conversation-row")).toHaveCount(DOCUMENT.length - 1);
  await expect(sheet(page)).not.toContainText(DOCUMENT[1].title);
  await expect(trigger(page)).toContainText(DOCUMENT[0].title);
});

test("+ starts a new chat that lists the latest two others", async ({ page }) => {
  await openChat(page);
  await header(page).getByLabel("New chat").click();
  await expect(trigger(page)).toHaveText("New chat");
  // A blank chat cannot start another blank one.
  await expect(header(page).getByLabel("New chat")).toBeDisabled();
  const earlier = page.getByRole("region", { name: "Earlier chats" });
  await expect(earlier.locator(".conversation-row")).toHaveCount(2);
  await expect(earlier.locator(".conversation-row").first()).toContainText(DOCUMENT[0].title);
  await earlier.getByRole("button", { name: new RegExp(`^${DOCUMENT[1].title}`) }).click();
  await expect(trigger(page)).toHaveText(DOCUMENT[1].title);
  await expect(earlier).toHaveCount(0);
});

test("the Memory page lists its chats under Today, This week and Earlier, below New chat", async ({ page }) => {
  await serve(page);
  await page.goto(`/tests/browser/harness.html?rail&scope=general&conversation=${idOf("general", 1)}`);
  const list = page.getByRole("navigation", { name: "Memory chats" });
  await expect(list.locator(".conversation-label")).toHaveText(["Today", "This week", "Earlier"]);
  await expect(list.locator(":scope > *").first()).toHaveText("New chat");
  await expect(list.getByRole("region", { name: "This week" }).locator(".conversation-row")).toHaveAttribute("data-conversation", idOf("general", 1));
  await expect(list.locator(".conversation-row.is-current")).toContainText(MEMORY[1].title);
  // New chat heads Today until its first question is sent.
  await list.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByTestId("open")).toHaveText("provisional");
  const todays = list.getByRole("region", { name: "Today" }).locator(".conversation-row");
  await expect(todays.first()).toHaveClass(/is-current/);
  await expect(todays.first()).toContainText("New chat");
  await list.getByRole("button", { name: new RegExp(`^${MEMORY[2].title}`) }).click();
  await expect(page.getByTestId("open")).toHaveText(idOf("general", 2));
});
