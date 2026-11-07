import { expect, test, type Page } from "@playwright/test";
import { contextNameFits, visibleConversationCount } from "../../app/lib/conversation-layout";

// The strip's geometry and its context menu across the rail's widths.
const titles = {
  document: ["Who Are vLLM-Omni’s Core Contributors?", "vLLM-Omni’s Multi-Stage Design", "A Minimal Streaming Runtime", "Chinchilla and MoE scaling laws compared across seven papers of the reading list"],
  general: ["What do I know about speculative decoding?", "KV cache strategies across my papers"],
};
const idOf = (scope: "document" | "general", index: number) => (scope === "general" ? "e" : "d") + String(index).repeat(31);

async function open(page: Page, width: number, url = "/tests/browser/harness.html?responsive-chat&closable") {
  const deleted: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") === "general" ? "general" : "document";
    const items = titles[scope].map((title, index) => ({ id: idOf(scope, index), generation: 0, title, empty: false, lastEngagedAt: new Date(Date.now() - index * 3 * 3600_000).toISOString() }))
      .filter(item => !deleted.includes(item.id));
    if (url.pathname.endsWith("/chat/conversations")) return route.fulfill({ json: { items, defaultId: items[0].id, limit: 10 } });
    if (url.pathname.endsWith("/chat") && route.request().method() === "DELETE") {
      deleted.push(url.searchParams.get("conversation_id")!);
      const rest = items.filter(item => !deleted.includes(item.id));
      return route.fulfill({ json: { selectedId: rest[0].id, catalog: { items: rest, defaultId: rest[0].id, limit: 10 } } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(url);
  await setWidth(page, width);
  await expect(page.getByRole("tab").first()).toBeVisible();
  return deleted;
}
/** Resizes the rail and waits for the strip to recount its tabs, two frames on. */
const setWidth = (page: Page, width: number) => page.getByTestId("chat-width").evaluate(async (el, width) => {
  el.style.width = `${width}px`;
  for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
}, width);
const contextButton = (page: Page) => page.locator(".conversation-header").getByRole("button", { name: /^Chat context:/ });
async function pointAt(page: Page, label: "Project" | "Memory") {
  if (await contextButton(page).getAttribute("aria-expanded") !== "true") await contextButton(page).click();
  // Pointed at once the roll has come to rest: a row still sliding into place
  // would put another context under the pointer first.
  await expect.poll(() => page.locator(".conversation-scope-roll").evaluate(roll => roll.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  await page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).hover();
  const list = page.getByRole("menu", { name: `${label} chats`, exact: true });
  await expect(list).toBeVisible();
  return list;
}

/** Where everything in the strip sits, relative to the card. */
function measure(page: Page) {
  return page.locator(".chat-surface").evaluate(card => {
    const box = (element: Element | null) => element ? element.getBoundingClientRect().toJSON() as DOMRect : null;
    const header = card.querySelector(".conversation-header")!;
    const tabs = [...header.querySelectorAll(".conversation-tab")].map(tab => ({ ...box(tab)!, active: tab.classList.contains("active") }));
    const parts = [".conversation-scope-menu", ".conversation-tabs", ".conversation-new", ".composer-mode-label", ".conversation-window-controls"].flatMap(selector => {
      const element = header.querySelector(selector);
      // The Chat tag is only announced, at a 1px box.
      return element && element.getBoundingClientRect().width > 1 ? [{ selector, ...box(element)! }] : [];
    });
    const add = box(header.querySelector(".conversation-new"))!;
    const controls = header.querySelector(".conversation-window-controls");
    const divider = controls ? getComputedStyle(controls, "::before") : null;
    const messages = card.querySelector(".messages")!;
    const name = header.querySelector(".conversation-scope-name")!;
    return {
      card: box(card)!, header: box(header)!, tabs, parts,
      // The divider is the controls' first 1px, after its 2px margin.
      airBeforeDivider: controls && divider?.display !== "none" ? box(controls)!.left + 2 - add.right : null,
      // How far each control's glyph sits off its button's middle.
      glyphOffsets: [...header.querySelectorAll(".conversation-new svg, .conversation-window-button svg")].map(svg => {
        const glyph = box(svg)!, button = box(svg.parentElement)!;
        return Math.abs(glyph.top + glyph.height / 2 - (button.top + button.height / 2));
      }),
      scopeNamed: name.getBoundingClientRect().width > 0,
      // The name's own width with the badge's gap, and the strip's content box as the rail measures it.
      nameCost: parseFloat(getComputedStyle(name).getPropertyValue("--scope-name-width")) + parseFloat(getComputedStyle(name.parentElement!).columnGap),
      strip: (() => { const nav = header.querySelector(".conversation-navigation")!, style = getComputedStyle(nav); return nav.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); })(),
      messagesTop: box(messages)!.top - box(header)!.bottom,
      messagesPadding: parseFloat(getComputedStyle(messages).paddingTop),
      hairline: getComputedStyle(header).borderBottomWidth,
    };
  });
}

test("the strip fits every rail width without overlap, and the context gives up its name before the tabs their width", async ({ page }) => {
  await open(page, 600);
  for (const width of [280, 300, 320, 360, 404, 420, 480, 560, 600, 680, 703, 704, 760, 900, 1100]) {
    await setWidth(page, width);
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await measure(page)).card.width).toBe(width);
    // ResizeObserver can commit the new strip width after a frame with no
    // animations. Wait for the layout contract as well as the name's easing.
    const name = page.locator(".conversation-header .conversation-scope-name");
    await expect.poll(async () => {
      const settled = await measure(page);
      const iconStrip = settled.strip + (settled.scopeNamed ? settled.nameCost : 0);
      return settled.scopeNamed === contextNameFits(iconStrip, settled.nameCost, 4)
        && settled.tabs.length === visibleConversationCount(iconStrip, 4)
        && await name.evaluate(node => node.getAnimations().length === 0);
    }).toBe(true);
    const m = await measure(page);
    // One row, in order, inside the card.
    for (const [index, part] of m.parts.entries()) {
      expect(part.right, `${part.selector} inside the card at ${width}px`).toBeLessThanOrEqual(m.card.right + 0.5);
      expect(part.bottom).toBeLessThanOrEqual(m.header.bottom + 1);
      // Centred on the strip, nothing rises above the tab on screen.
      const active = m.tabs.find(tab => tab.active);
      if (active) expect(part.top, `${part.selector} below the tab's top at ${width}px`).toBeGreaterThanOrEqual(active.top - 0.5);
      if (index) expect(part.left, `${part.selector} after ${m.parts[index - 1].selector} at ${width}px`).toBeGreaterThanOrEqual(m.parts[index - 1].right - 0.5);
    }
    // Every tab keeps its readable width while more than one is shown; the rest wait in the context's list.
    if (m.tabs.length > 1) for (const tab of m.tabs) expect(tab.width, `tab at ${width}px`).toBeGreaterThanOrEqual(tab.active ? 159.5 : 127.5);
    for (const offset of m.glyphOffsets) expect(offset, `glyph centred at ${width}px`).toBeLessThanOrEqual(0.5);
    if (width > 404) expect(m.airBeforeDivider, `air before the divider at ${width}px`).toBeGreaterThanOrEqual(19.5);
    // The name shows wherever the strip can spare it without a tab paying for it.
    const iconStrip = m.strip + (m.scopeNamed ? m.nameCost : 0);
    expect(m.scopeNamed, `context named at ${width}px`).toBe(contextNameFits(iconStrip, m.nameCost, 4));
    expect(m.tabs.length, `tabs at ${width}px`).toBe(visibleConversationCount(iconStrip, 4));
    // The tab on screen opens through the hairline into the transcript, 44px above its first line, past the fade.
    expect(m.hairline).toBe("1px");
    expect(m.tabs.find(tab => tab.active)!.bottom).toBeCloseTo(m.header.bottom, 0);
    expect(m.messagesPadding).toBe(44);
    expect(m.messagesTop).toBeCloseTo(0, 0);
  }
  await setWidth(page, 600);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await setWidth(page, 900);
  await expect(page.getByRole("tab")).toHaveCount(4);
});

for (const width of [600, 900]) {
test(`pointing at a context lists its chats beside the menu, level with its first row (${width}px)`, async ({ page }) => {
  await open(page, width);
  for (const label of ["Project", "Memory"] as const) {
    const list = await pointAt(page, label);
    const place = await list.evaluate(node => {
      const box = node.getBoundingClientRect(), card = node.closest(".chat-surface")!.getBoundingClientRect();
      const roll = node.parentElement!.querySelector(".conversation-scope-roll")!.getBoundingClientRect();
      const first = node.parentElement!.querySelector("[role=menuitemradio]")!.getBoundingClientRect();
      return { top: box.top - first.top, gap: box.left - roll.right, right: card.right - box.right, bottom: card.bottom - box.bottom };
    });
    expect(Math.abs(place.top), `${label} list top`).toBeLessThan(1);
    expect(place.gap).toBeCloseTo(6, 0);
    expect(place.right).toBeGreaterThanOrEqual(8);
    expect(place.bottom).toBeGreaterThanOrEqual(8);
  }
  // The roll's rows keep their own count and ›, and the list belongs to the context pointed at.
  await expect(page.getByRole("menuitemradio", { name: /^Project/ })).toHaveAccessibleName(/4 threads/);
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toHaveAccessibleName(/2 threads/);
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu", { name: "Project chats" })).toHaveCount(0);
});
}

for (const width of [320, 360]) {
test(`without room beside the menu the chats drop below it, across the panel (${width}px)`, async ({ page }) => {
  await open(page, width);
  const list = await pointAt(page, "Project");
  const place = await list.evaluate(node => {
    const box = node.getBoundingClientRect(), card = node.closest(".chat-surface")!.getBoundingClientRect();
    const roll = node.parentElement!.querySelector(".conversation-scope-roll")!.getBoundingClientRect();
    return { gap: box.top - roll.bottom, left: box.left - card.left, right: card.right - box.right };
  });
  expect(place.gap).toBeCloseTo(6, 0);
  expect(place.left).toBeCloseTo(12, 0);
  expect(place.right).toBeCloseTo(12, 0);
  // The contexts and their chats read at one size.
  const size = (selector: string) => page.locator(selector).first().evaluate(element => getComputedStyle(element).fontSize);
  expect(await size(".conversation-scope-roll button")).toBe(await size(".conversation-menu-row > button"));
  // The roll is as narrow as its rows allow: each name keeps air before its count.
  for (const air of await page.locator(".conversation-scope-roll button").evaluateAll(rows => rows.map(row => {
    const name = document.createRange(); name.selectNodeContents(row.querySelector(".conversation-scope-label")!);
    return row.querySelector(".conversation-scope-count")!.getBoundingClientRect().left - name.getBoundingClientRect().right;
  }))) expect(air).toBeGreaterThanOrEqual(8);
  expect((await page.locator(".conversation-scope-roll").boundingBox())!.width).toBeLessThanOrEqual(124);
  // Titles keep one line, a long one fading at its end; the time stays on the right of every row.
  const rows = list.locator(".conversation-menu-row > [role=menuitem]");
  await expect(rows).toHaveCount(4);
  const long = rows.filter({ hasText: "seven papers" });
  const shape = await long.evaluate(row => {
    const title = row.querySelector(".conversation-chat-title")!, when = row.querySelector(".conversation-chat-when")!;
    return { lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)), long: title.classList.contains("is-long"), whenRight: row.getBoundingClientRect().right - when.getBoundingClientRect().right };
  });
  expect(shape).toMatchObject({ lines: 1, long: true });
  expect(shape.whenRight).toBeCloseTo(10, 0);
  // Under the pointer it runs like a ticker, as Memory's titles do.
  await long.hover();
  await expect.poll(() => long.locator(".kb-related-track").evaluate(track => track.getAnimations().map(animation => (animation as CSSAnimation).animationName))).toContain("kb-related-ticker");
  await expect(rows.first()).toContainText("Open");
  await expect(rows.nth(1)).toContainText(/\d+h$/);
});
}

test("Delete sits inside the list when the panel has no room beside it, and only the context on screen offers it", async ({ page }) => {
  const deleted = await open(page, 320);
  let list = await pointAt(page, "Memory");
  await list.locator(".conversation-menu-row").first().click({ button: "right" });
  await expect(list.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /^Options for/ })).toHaveCount(0);
  list = await pointAt(page, "Project");
  const row = list.locator(".conversation-menu-row").nth(2);
  const more = row.getByRole("button", { name: /^Options for A Minimal/ });
  await expect(more).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(more).toHaveCSS("opacity", "1");
  await more.click();
  const remove = list.getByRole("menuitem", { name: /^Delete A Minimal/ });
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect(await remove.evaluate(node => {
    const box = node.getBoundingClientRect(), list = node.closest("[role=menu]")!.getBoundingClientRect();
    const row = document.querySelector(".conversation-menu-row.is-open")!.getBoundingClientRect();
    return box.left >= list.left && box.right <= list.right && Math.abs((box.top + box.bottom) / 2 - (row.top + row.bottom) / 2) < 1;
  })).toBe(true);
  // The ⋮ stays visible beside it and closes it again.
  await more.click();
  await expect(remove).toHaveCount(0);
  await row.click({ button: "right" });
  await remove.click();
  await expect(page.getByRole("menu", { name: "Project chats" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(deleted).toEqual([idOf("document", 2)]);
  await contextButton(page).click();
  await expect(page.getByRole("menuitemradio", { name: /^Project/ })).toHaveAccessibleName(/3 threads/);
});

for (const width of [600, 900]) {
test(`with room beside the list, Delete opens right of it, level with its row and covering nothing (${width}px)`, async ({ page }) => {
  await open(page, width);
  const list = await pointAt(page, "Project");
  const row = list.locator(".conversation-menu-row").nth(2);
  await row.hover();
  await row.getByRole("button", { name: /^Options for A Minimal/ }).click();
  const remove = list.getByRole("menuitem", { name: /^Delete A Minimal/ });
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect(await remove.evaluate(node => {
    const box = node.getBoundingClientRect(), list = node.closest("[role=menu]")!.getBoundingClientRect();
    const row = document.querySelector(".conversation-menu-row.is-open")!.getBoundingClientRect();
    const panel = node.closest(".chat-surface")!.getBoundingClientRect();
    return box.left > list.right && box.right <= panel.right && Math.abs((box.top + box.bottom) / 2 - (row.top + row.bottom) / 2) < 1;
  })).toBe(true);
  // Scrolled out of a short list, its row takes the Delete with it, and brings it back.
  const rows = list.locator(".conversation-chat-rows");
  await rows.evaluate(node => { node.style.height = "36px"; node.scrollTop = 0; });
  await expect(remove).toBeHidden();
  await rows.evaluate(node => { node.scrollTop = (node.querySelector(".conversation-menu-row.is-open") as HTMLElement).offsetTop - 4; });
  await expect(remove).toBeVisible();
  await rows.evaluate(node => { node.style.height = ""; });
  await remove.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
}

test("the keyboard reaches a context's chats and opens one in that context", async ({ page }) => {
  await open(page, 600);
  await contextButton(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /^Project/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toBeFocused();
  // Arrows in the roll skip the list hanging beside it.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /^Project/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toBeFocused();
  // Once Memory has been read, its row opens onto its chats.
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toHaveAccessibleName(/2 threads/);
  await page.keyboard.press("ArrowRight");
  const list = page.getByRole("menu", { name: "Memory chats" });
  await expect(list.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("menuitem").nth(1)).toBeFocused();
  // Left, or Escape, puts the chats away and returns to their context.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toBeFocused();
  await expect(list).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(list.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toBeFocused();
  // Straight back in and on, as fast as keys come, once the chats are shown.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(list).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(contextButton(page)).toHaveAccessibleName("Chat context: Memory");
  await expect(page.getByRole("tab", { selected: true })).toContainText("KV cache strategies");
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).toBe(idOf("general", 1));
  // A chat of the context on screen opens without leaving it.
  await (await pointAt(page, "Memory")).getByRole("menuitem", { name: /^What do I know/ }).click();
  await expect(contextButton(page)).toHaveAccessibleName("Chat context: Memory");
  await expect(page.getByRole("tab", { selected: true })).toContainText("What do I know");
});

test("window buttons are separate, named on hover, and their tips stay inside the card", async ({ page }) => {
  await open(page, 320);
  for (const name of ["Expand chat", "Hide chat"]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.hover();
    const tip = () => button.evaluate(node => {
      const style = getComputedStyle(node, "::after");
      const card = node.closest(".chat-surface")!.getBoundingClientRect(), box = node.getBoundingClientRect();
      // Anchored at the button's right edge, the tip grows leftward into the card.
      return { text: style.content, opacity: style.opacity, inside: box.right - parseFloat(style.right) <= card.right && box.right - parseFloat(style.width) >= card.left };
    });
    await expect.poll(async () => (await tip()).opacity).toBe("1");
    expect(await tip()).toMatchObject({ text: `"${name}"`, inside: true });
  }
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  await page.getByRole("button", { name: "Collapse chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("false");
  await page.getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
});

test("in full screen, Escape closes an open menu first, wherever focus is, and leaves full screen only after", async ({ page }) => {
  await open(page, 600);
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  const menus = [
    { trigger: contextButton(page), menu: page.locator(".conversation-header").getByRole("menu", { name: /^Chat context/ }) },
    { trigger: page.getByRole("button", { name: "Answer persona" }), menu: page.getByRole("listbox", { name: "Choose answer persona" }) },
  ];
  // Focus on the trigger, as a click leaves it in Chromium, and on the page, as in Safari.
  for (const { trigger, menu } of menus) for (const focus of ["trigger", "page"]) {
    await trigger.click();
    await expect(menu).toBeVisible();
    if (focus === "page") await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("fullscreen")).toHaveText("true");
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fullscreen")).toHaveText("false");
});

test("a tab's cross waits for the pointer or the keyboard; a tab behind the one on screen closes from it", async ({ page }) => {
  await open(page, 900);
  await page.mouse.move(0, 400);
  for (const tab of await page.locator(".conversation-tab").all()) await expect(tab.locator(".conversation-tab-close")).toHaveCSS("opacity", "0");
  const active = page.locator(".conversation-tab.active");
  await active.hover();
  await expect(active.locator(".conversation-tab-close")).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 400);
  await active.getByRole("tab").focus();
  await expect(active.locator(".conversation-tab-close")).toHaveCSS("opacity", "1");
  await active.getByRole("tab").blur();
  const behind = page.locator(".conversation-tab:not(.active)").first();
  const cross = behind.locator(".conversation-tab-close");
  await expect(cross).toHaveCSS("opacity", "0");
  await behind.hover();
  await expect(cross).toHaveCSS("opacity", "1");
  const title = await behind.getByRole("tab").getAttribute("title");
  await cross.click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(page.getByRole("tab", { selected: true })).toContainText(titles.document[0]);
  await expect((await pointAt(page, "Project")).getByRole("menuitem", { name: new RegExp(`^${title!.slice(0, 12)}`) })).toBeVisible();
});

for (const width of [460, 600]) {
test(`the pointer reaches a context's chats across the other context without swapping them (${width}px)`, async ({ page }) => {
  await open(page, width);
  await contextButton(page).click();
  const project = page.getByRole("menuitemradio", { name: /^Project/ });
  await expect(page.getByRole("menuitemradio", { name: /^Memory/ })).toHaveAccessibleName(/2 threads/);
  // Measured once the roll has come to rest.
  await expect.poll(() => page.locator(".conversation-scope-roll").evaluate(roll => roll.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  const from = (await project.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  const list = page.getByRole("menu", { name: "Project chats" });
  await expect(list).toBeVisible();
  // A real path, through the Memory row, to the last of Project's chats.
  const to = (await list.getByRole("menuitem").last().boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.waitForTimeout(400);
  await expect(list).toBeVisible();
  await expect(page.getByRole("menu", { name: "Memory chats" })).toHaveCount(0);
  // Resting on Memory does swap them.
  const memory = (await page.getByRole("menuitemradio", { name: /^Memory/ }).boundingBox())!;
  await page.mouse.move(memory.x + 20, memory.y + memory.height / 2, { steps: 4 });
  await expect(page.getByRole("menu", { name: "Memory chats" })).toBeVisible();
});
}

test("hovering a row of the context on screen swaps its time for the ⋮ without moving anything", async ({ page }) => {
  await open(page, 600);
  const list = await pointAt(page, "Project");
  const row = list.locator(".conversation-menu-row").nth(3);
  const before = await row.boundingBox();
  const title = await row.locator(".conversation-chat-title").boundingBox();
  await row.hover();
  await expect(row.locator(".conversation-chat-when")).toHaveCSS("visibility", "hidden");
  await expect(row.getByRole("button", { name: /^Options for/ })).toHaveCSS("opacity", "1");
  expect(await row.boundingBox()).toEqual(before);
  expect(await row.locator(".conversation-chat-title").boundingBox()).toEqual(title);
});

test("the composer's context menu keeps its rosewood roll, counts chats as the header does, with none hanging from it", async ({ page }) => {
  // An empty chat is not counted, here or in the header's lists.
  const items = [{ id: "said", generation: 0, title: "Said", empty: false }, { id: "blank", generation: 0, title: "New chat", empty: true }];
  await page.route("**/api/**", route => route.fulfill({ json: { items, defaultId: "said", limit: 10 } }));
  await page.goto("/tests/browser/harness.html?ask");
  await page.getByRole("button", { name: /^Chat context/ }).click();
  const memory = page.getByRole("menuitemradio", { name: /^Memory/ });
  await expect(memory).toHaveAccessibleName(/1 thread$/);
  await expect(memory).not.toHaveAttribute("aria-haspopup");
  await expect(page.locator(".conversation-scope-more")).toHaveCount(0);
  await expect(page.locator(".conversation-scope-roll")).toHaveCSS("background-color", "rgb(166, 90, 80)");
  await memory.hover();
  await expect(page.locator(".conversation-chat-list")).toHaveCount(0);
});

test("an answer that failed is marked on its tab and in its list row once the reader looks elsewhere", async ({ page }) => {
  await open(page, 900);
  await page.route("**/api/chat/stream**", route => route.fulfill({ status: 500, json: { detail: "The model could not answer." } }));
  const first = page.getByRole("tab", { selected: true });
  const title = (await first.getAttribute("title"))!;
  await page.locator(".chat-surface").getByRole("textbox").fill("Answer this.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab").nth(1).click();
  const failed = page.locator(".conversation-tab", { hasText: title });
  await expect(failed.getByRole("img", { name: "Answer failed" })).toBeVisible();
  await expect(failed.getByRole("tab")).toHaveAttribute("title", `${title} · Answer failed`);
  const row = (await pointAt(page, "Project")).locator(".conversation-menu-row", { hasText: title });
  await expect(row.getByRole("img", { name: "Answer failed" })).toBeVisible();
});

test("with one chat open the context is named wherever its tab keeps its width, easing in and out as the rail resizes", async ({ page }) => {
  await open(page, 900);
  for (let left = 3; left > 0; left--) {
    const behind = page.locator(".conversation-tab:not(.active)").first();
    await behind.hover();
    await behind.locator(".conversation-tab-close").click();
    await expect(page.getByRole("tab")).toHaveCount(left);
  }
  const name = page.locator(".conversation-header .conversation-scope-name");
  const width = () => name.evaluate(node => node.getBoundingClientRect().width);
  await setWidth(page, 320);
  await expect.poll(width).toBe(0);
  // The reader's docked rail: plenty of strip beside the one tab.
  await setWidth(page, 687);
  await expect.poll(() => name.evaluate(node => node.getAnimations().map(animation => (animation as CSSTransition).transitionProperty))).toContain("max-width");
  await expect.poll(width).toBeGreaterThan(30);
  await expect(name).toHaveCSS("opacity", "1");
  await setWidth(page, 460);
  await expect(name).toHaveCSS("opacity", "1");
  await setWidth(page, 320);
  await expect.poll(() => name.evaluate(node => node.getAnimations().length)).toBeGreaterThan(0);
  await expect.poll(width).toBe(0);
});

test("named, the context keeps one width for Project and Memory, with air before its chevron", async ({ page }) => {
  await open(page, 700);
  const trigger = contextButton(page);
  const shape = () => trigger.evaluate(button => {
    const name = button.querySelector(".conversation-scope-name")!, chevron = button.querySelector(".conversation-chevron")!;
    const range = document.createRange(); range.selectNodeContents(name);
    return { width: Math.round(button.getBoundingClientRect().width), air: chevron.getBoundingClientRect().left - range.getBoundingClientRect().right };
  });
  const settled = () => expect.poll(() => trigger.locator(".conversation-scope-name").evaluate(name => name.getAnimations().length)).toBe(0);
  await expect.poll(async () => (await shape()).width).toBeGreaterThan(90);
  await settled();
  const project = await shape();
  await trigger.click();
  await page.getByRole("menuitemradio", { name: /^Memory/ }).click();
  await expect(contextButton(page)).toHaveAccessibleName(/Memory/);
  await settled();
  expect((await shape()).width).toBe(project.width);
  for (const { air } of [project, await shape()]) expect(air).toBeGreaterThanOrEqual(8);
});
