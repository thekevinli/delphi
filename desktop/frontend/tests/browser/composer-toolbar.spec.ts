import { test, expect, type Page, type Locator } from "@playwright/test";

const id = (n: number) => String(n).repeat(32);

async function routeChat(page: Page, posted: string[] = [], messages: unknown[] = []) {
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/chat/conversations") && request.method() === "POST") {
      posted.push(request.postData() ?? "");
      return route.fulfill({ json: { id: id(7), generation: 0, title: "", empty: true, kind: "general_chat" } });
    }
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: id(1), generation: 0, title: "Attention and memory", empty: false, kind: "document_chat", projectId: "project", paperId: "paper" }],
      defaultId: id(1), limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages, images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
}

const box = async (locator: Locator) => (await locator.boundingBox())!;
const right = (b: { x: number; width: number }) => b.x + b.width;

/** Hover the persona and sample every frame: the name unrolls to the left, so
    the mark and everything to its right hold still while it opens. */
async function hoverPersona(page: Page, row: Locator, persona: Locator, send: Locator) {
  const mark = persona.locator(".element-icon");
  const [markBefore, sendBefore, pillBefore] = [await box(mark), await box(send), await box(persona)];
  await persona.hover();
  const samples = await row.evaluate(async element => {
    const mark = element.querySelector(".persona-pill .element-icon")!;
    const pill = element.querySelector(".persona-pill-trigger")!;
    const out: number[][] = [];
    const until = performance.now() + 700;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const m = mark.getBoundingClientRect(), p = pill.getBoundingClientRect();
      out.push([m.x, p.x + p.width, p.width]);
    }
    return out;
  });
  expect(samples.every(([markX, pillRight]) => Math.abs(markX - markBefore.x) < 0.5 && Math.abs(pillRight - right(pillBefore)) < 0.5)).toBe(true);
  expect(samples.at(-1)![2]).toBeGreaterThan(pillBefore.width + 10);
  expect((await box(send)).x).toBeCloseTo(sendBefore.x, 0);
  const label = page.locator(".persona-pill-label");
  await expect(label).toHaveCSS("opacity", "1");
  expect(right(await box(label))).toBeLessThanOrEqual((await box(mark)).x + 0.5);
}

/** Wait out every finite animation and transition on the page. */
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
  .map(animation => animation.finished.catch(() => {}))));

/** Open a menu straight from rest, as a quick click does: the persona's name
    is still rolled up when the menu measures its room. Returns it settled. */
async function openFromRest(page: Page, trigger: Locator, menu: Locator) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator(".persona-pill-label")).toHaveCSS("max-width", "0px");
  await trigger.click();
  await expect(menu).toBeVisible();
  await settle(page);
  return box(menu);
}

/** The persona menu hangs from its pill's right edge, as wide as the room to
    the clipping edge allows (400px at most, 240px at least), and inside it. */
async function expectPersonaMenu(page: Page, menu: Locator, clip: Locator) {
  const [m, pill, c] = [await box(menu), await box(page.locator(".persona-pill")), await box(clip)];
  const room = right(pill) - c.x;
  expect(m.x).toBeGreaterThanOrEqual(c.x - 0.5);
  expect(right(m)).toBeLessThanOrEqual(right(c) + 0.5);
  // Measured at the click, before the open pill reaches 3px further right.
  expect(m.width).toBeGreaterThanOrEqual(Math.max(240, Math.min(400, room)) - 4);
  if (room >= m.width) expect(Math.abs(right(m) - right(pill))).toBeLessThanOrEqual(3.5);
}

test("rail chat: attach alone on the left, model and persona beside send", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await routeChat(page);
  await page.goto("/tests/browser/harness.html?responsive-chat&personas");
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "440px"; });
  const row = page.locator(".composer-row");
  const attach = row.getByRole("button", { name: "Attach an image" });
  const model = row.getByRole("button", { name: /^Model:/ });
  const persona = row.getByRole("button", { name: "Answer persona", exact: true });
  const send = row.locator(".send-button");
  await expect(persona).toBeVisible();
  await expect(page.locator(".composer .composer-divider")).toHaveCount(0);

  const [a, m, p, s, r] = [await box(attach), await box(model), await box(row.locator(".persona-pill")), await box(send), await box(row)];
  expect(a.x - r.x).toBeLessThan(4);
  expect(right(a)).toBeLessThan(m.x - 40);
  expect(right(m)).toBeLessThanOrEqual(p.x);
  expect(right(p)).toBeLessThanOrEqual(s.x);
  expect(right(r) - right(s)).toBeLessThan(1);
  await expect(page.locator(".persona-pill-label")).toHaveCSS("opacity", "0");
  await page.locator(".composer").screenshot({ path: test.info().outputPath("rail-at-rest.png") });

  await hoverPersona(page, row, persona, send);
  await page.locator(".composer").screenshot({ path: test.info().outputPath("rail-persona-open.png") });

  // Choose a persona with a long name: its menu opens beside its pill and
  // inside the rail's card, however quickly it is clicked.
  const composer = page.locator(".composer");
  const menu = page.getByRole("listbox", { name: "Choose answer persona" });
  const models = page.getByRole("menu", { name: "Choose model" });
  await openFromRest(page, persona, menu);
  await expectPersonaMenu(page, menu, composer);
  await menu.getByRole("option", { name: /Literature Cartographer/ }).click();
  await expect(menu).not.toBeVisible();
  await expect(page.locator(".persona-pill")).toHaveAttribute("data-element", "leaf");
  await openFromRest(page, model, models);
  const wideModels = await box(models);
  expect(wideModels.x).toBeGreaterThanOrEqual((await box(composer)).x - 0.5);
  expect(right(wideModels)).toBeCloseTo(right(await box(model)), 0);
  // Escape closes it with focus on the page too, where a click leaves it in Safari.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(models).not.toBeVisible();

  // At the rail's 320px minimum both menus still fit, the long name included.
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "320px"; });
  await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", "true");
  await settle(page);
  await openFromRest(page, persona, menu);
  await expectPersonaMenu(page, menu, composer);
  await expect(page.locator(".persona-pill-label")).toHaveText("Literature Cartographer");
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  const narrowModels = await openFromRest(page, model, models);
  const narrow = await box(composer);
  expect(narrowModels.x).toBeGreaterThanOrEqual(narrow.x - 0.5);
  expect(right(narrowModels)).toBeLessThanOrEqual(right(narrow) + 0.5);
  await page.keyboard.press("Escape");
  await expect(models).not.toBeVisible();

  await page.locator(".composer-input").click();
  await page.keyboard.type("How does attention scale?");
  await expect(send).toBeEnabled();
  expect(errors).toEqual([]);
});

test("a narrow rail keeps the model menu in view, in the composer and while editing a question", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await routeChat(page, [], [
    { role: "user", content: "What does this build on?", createdAt: "2026-10-12T00:00:00Z", requestId: "r1" },
    { role: "assistant", content: "Mostly on sparse routing.", createdAt: "2026-10-12T00:00:05Z", requestId: "r1" },
  ]);
  await page.goto("/tests/browser/harness.html?responsive-chat&personas");
  // The Memory rail allows 272px, below the reader's 320px minimum.
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "272px"; });
  const models = page.getByRole("menu", { name: "Choose model" });
  const inside = async (clip: Locator) => {
    const [m, c] = [await box(models), await box(clip)];
    expect(m.x).toBeGreaterThanOrEqual(c.x - 0.5);
    expect(right(m)).toBeLessThanOrEqual(right(c) + 0.5);
  };
  await openFromRest(page, page.locator(".composer-row").getByRole("button", { name: /^Model:/ }), models);
  await inside(page.locator(".chat-surface"));
  await page.keyboard.press("Escape");

  await page.locator(".message.user").hover();
  await page.getByRole("button", { name: "Edit message" }).click();
  const editing = page.locator(".composer-edit");
  await expect(editing.getByRole("button", { name: "Cancel edit" })).toBeVisible();
  const editModel = editing.getByRole("button", { name: /^Model:/ });
  await openFromRest(page, editModel, models);
  await inside(page.locator(".messages"));
  await editModel.click();
  await expect(models).not.toBeVisible();
  await editing.getByRole("button", { name: "Cancel edit" }).click();
  await expect(editing).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Composer: attach and past conversations on the left, model and persona beside send", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const posted: string[] = [];
  await routeChat(page, posted);
  await page.goto("/tests/browser/harness.html?ask");
  const card = page.getByRole("dialog", { name: "Ask Delphi" });
  const row = card.locator(".kb-composer-tools");
  const history = row.getByRole("button", { name: "See past conversations" });
  const model = row.getByRole("button", { name: /^Model:/ });
  const persona = row.getByRole("button", { name: "Answer persona", exact: true });
  const send = row.getByRole("button", { name: "Send" });
  await expect(persona).toBeVisible();
  // Measure the card once its opening morph has settled.
  await card.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await expect(card.locator(".composer-divider")).toHaveCount(0);

  const [a, h, m, p, s, r] = [await box(row.locator(".composer-toggle-slot")), await box(history), await box(model), await box(row.locator(".persona-pill")), await box(send), await box(row)];
  expect(a.x - r.x).toBeLessThan(4);
  expect(h.x - right(a)).toBeCloseTo(8, 0);
  expect(right(h)).toBeLessThan(m.x - 200);
  expect(m.x).toBeGreaterThan(r.x + r.width / 2);
  expect(p.x - right(m)).toBeCloseTo(8, 0);
  expect(s.x - right(p)).toBeCloseTo(8, 0);
  expect(right(r) - right(s)).toBeLessThan(1);
  await card.screenshot({ path: test.info().outputPath("composer-at-rest.png") });

  await hoverPersona(page, row, persona, send);
  await card.screenshot({ path: test.info().outputPath("composer-persona-open.png") });

  // Past conversations still widens to its own right, into the empty middle,
  // and moves none of the choices beside send.
  await expect(history).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await history.hover();
  await expect(page.locator(".persona-pill-label")).toHaveCSS("max-width", "0px");
  const modelBefore = await box(model);
  await expect(history.locator("span")).toHaveCSS("opacity", "1");
  await settle(page);
  // Open, it wears the model pill's white and hairline; at rest it has neither.
  await expect(history).toHaveCSS("background-color", await model.evaluate(element => getComputedStyle(element).backgroundColor));
  await expect(history).not.toHaveCSS("box-shadow", "none");
  expect(right(await box(history))).toBeLessThan(modelBefore.x);
  expect((await box(model)).x).toBeCloseTo(modelBefore.x, 0);

  const menu = page.getByRole("listbox", { name: "Choose answer persona" });
  await openFromRest(page, persona, menu);
  await expectPersonaMenu(page, menu, card);
  expect((await box(menu)).width).toBeCloseTo(400, 0);
  await menu.getByRole("option", { name: /ADHD/ }).click();
  await expect(page.locator(".persona-pill")).toHaveAttribute("data-element", "bolt");

  const models = page.getByRole("menu", { name: "Choose model" });
  const modelsBox = await openFromRest(page, model, models);
  expect(right(modelsBox)).toBeCloseTo(right(await box(model)), 0);
  await page.keyboard.press("Escape");

  await history.click();
  await expect(page.getByTestId("history")).toHaveText("1");

  await card.locator(".composer-input").click();
  await page.keyboard.type("What does attention cost at long context?");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("sent")).toHaveText(JSON.stringify({ prompt: "What does attention cost at long context?", personaId: "adhd" }));
  expect(posted).toHaveLength(1);

  expect(errors).toEqual([]);
});

test("Composer hints the Plan mode shortcut in code type; the rail hints at /side instead", async ({ page }) => {
  await routeChat(page);
  await page.goto("/tests/browser/harness.html?ask");
  const input = page.getByRole("dialog", { name: "Ask Delphi" }).locator(".composer-input");
  await expect(input).toHaveAttribute("aria-placeholder", "Hint: toggle Plan mode by pressing shift+tab");
  const hint = input.locator("+ .composer-placeholder");
  await expect(hint).toHaveText("Hint: toggle Plan mode by pressing shift+tab");
  await expect(hint.locator("code")).toHaveText("shift+tab");
  expect(await hint.locator("code").evaluate(element => getComputedStyle(element).fontFamily)).toContain("JetBrains Mono");
  expect(await hint.evaluate(element => getComputedStyle(element).fontFamily)).not.toContain("JetBrains Mono");
  // Drawn once: the field's own placeholder stands down.
  expect(await input.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none");
  await input.focus();
  await page.keyboard.type("a");
  await expect(hint).toBeHidden();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toHaveAttribute("aria-placeholder", "What should we plan?");
  await expect(hint).toHaveCount(0);

  await page.goto("/tests/browser/harness.html?responsive-chat&personas");
  await expect(page.locator(".composer-input")).toHaveAttribute("aria-placeholder", "Hint: press /side to toggle side chat for quick questions");
  await expect(page.locator(".composer-placeholder code")).toHaveText("/side");
});
