import { test, expect, type Page } from "@playwright/test";

/** A context's chats, shown by pointing at it in the open context menu. */
async function contextList(page: Page, label = "Project") {
  await page.getByRole("button", { name: /^Chat context:/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).hover();
  return page.getByRole("menu", { name: `${label} chats`, exact: true });
}

for (const count of [1, 4]) {
test(`chat controls stay on one row with ${count} conversations`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: Array.from({ length: count }, (_, i) => ({ id: String(i + 1).repeat(32), generation: 0, title: `Literature discussion ${i}: how neurons scale and specialize across models`, empty: false, kind: "document_chat", projectId: "project", paperId: "paper" })),
      defaultId: "1".repeat(32), limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat");
  const surface = page.locator(".chat-surface");
  await expect(surface).toBeVisible();
  await expect(page.locator(".composer-input")).toHaveAttribute("data-placeholder", "Hint: press /side to toggle side chat for quick questions");
  // Include the 320px minimum and narrower historical problem widths so
  // increasing the minimum cannot conceal a hover or wrapping regression.
  for (const width of [760, 600, 460, 420, 360, 350, 340, 320, 290, 288, 280, 704, 703, 760]) {
    await page.getByTestId("chat-width").evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", String(width <= 420));
    await expect(page.locator(".model-badge")).not.toHaveAttribute("data-morphing", "true");
    await expect.poll(async () => page.locator(".conversation-header").evaluate(header => {
      const close = header.querySelector(".conversation-tab.active .conversation-tab-close")?.getBoundingClientRect();
      const add = header.querySelector(".conversation-new")?.getBoundingClientRect();
      return Boolean(close && add && close.right <= add.left);
    })).toBe(true);
    await expect(page.locator(".conversation-header")).toHaveCSS("flex-wrap", "nowrap");
    const controls = await page.locator(".conversation-header").evaluate(header => {
      const selectors = [".conversation-scope-menu", ".conversation-tab.active", ".conversation-new", ".composer-mode-label", ".conversation-window-controls"];
      // The Chat tag is only announced, at a 1px box.
      const boxes = selectors.flatMap(selector => { const box = header.querySelector(selector)?.getBoundingClientRect(); return box && box.width > 1 ? [box] : []; });
      return boxes.every((box, index) => index === 0 || (box.left >= boxes[index - 1].right && box.top < boxes[0].bottom && box.bottom > boxes[0].top));
    });
    expect(controls, `header controls stay on one row at ${width}px`).toBe(true);
    // The attachment, then the model and persona beside send, share one row
    // down to the 320px minimum; only a narrower column may stack them.
    if (width >= 320) {
      const row = await page.locator(".composer-row").evaluate(row => {
        const boxes = [".composer-secondary-controls", ".composer-primary-controls", ".composer-send-group"].map(selector => row.querySelector(selector)!.getBoundingClientRect());
        return boxes.every((box, index) => index === 0 || (box.left >= boxes[index - 1].right && box.top < boxes[0].bottom && box.bottom > boxes[0].top));
      });
      expect(row, `composer controls stay on one row at ${width}px`).toBe(true);
    }
  }
  const suggestions = page.locator(".suggestions");
  await expect(suggestions.getByRole("button")).toHaveText(["Summarize this paper", "Connect to this project"]);
  const promptBox = await suggestions.boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(composerBox!.y - (promptBox!.y + promptBox!.height)).toBeGreaterThan(16);
  expect(composerBox!.y - (promptBox!.y + promptBox!.height)).toBeLessThan(60);
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "340px"; });
  const title = page.locator(".conversation-tab.active .conversation-tab-title");
  await expect(title).toHaveClass(/is-long/);
  await title.hover();
  await expect(title.locator(".kb-related-track")).toHaveCSS("animation-name", "kb-related-ticker");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(title.locator(".kb-related-track")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [280, 320, 340, 420, 500, 600]) {
    await page.getByTestId("chat-width").evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    const persona = page.getByRole("button", { name: "Answer persona", exact: true });
    await page.mouse.move(0, 0);
    await persona.blur();
    await expect(page.locator(".persona-pill-label")).toHaveCSS("opacity", "0");
    await expect(page.locator(".persona-pill-label")).toHaveCSS("max-width", "0px");
    await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", String(width <= 420));
    await expect(page.locator(".model-badge")).not.toHaveAttribute("data-morphing", "true");
    const collapsed = await persona.boundingBox();
    const pill = await page.locator(".persona-pill").boundingBox();
    // No invisible expanded-width spacer: just the icon and its 8px padding.
    expect(pill!.width).toBeLessThanOrEqual(31);
    if (width === 600) {
      const send = await page.locator(".composer-send-group").boundingBox();
      expect(send!.x - (pill!.x + pill!.width)).toBeCloseTo(8, 0);
      await surface.screenshot({ path: test.info().outputPath("wide-collapsed-persona.png") });
    }
    await persona.hover();
    // Sample every frame with a stationary pointer: a wrap/hover feedback loop
    // must not be hidden by checking only the final collapsed position.
    const positions = await persona.evaluate(async element => {
      const samples: number[][] = [];
      const until = performance.now() + 700;
      while (performance.now() < until) {
        await new Promise(requestAnimationFrame);
        const { x, y, width, height } = element.getBoundingClientRect();
        samples.push([x, y, width, height]);
      }
      return samples;
    });
    // The name unrolls leftward: the right edge, and so the mark beside send, holds.
    expect(positions.every(sample => [1, 3].every(index => Math.abs(sample[index] - positions[0][index]) < 0.1))).toBe(true);
    expect(Math.max(...positions.map(sample => Math.abs(sample[0] + sample[2] - positions[0][0] - positions[0][2]))), `right edge at ${width}px`).toBeLessThan(0.1);
    expect(positions.at(-1)![2], `persona expands at ${width}px`).toBeGreaterThan(collapsed!.width + 10);
    expect(positions.every((sample, index) => index === 0 || sample[2] >= positions[index - 1][2] - 0.1)).toBe(true);
    expect(await page.locator(".persona-pill-label").evaluate(element => {
      const label = element.getBoundingClientRect();
      const button = element.closest('button')!.getBoundingClientRect();
      return label.top >= button.top && label.bottom <= button.bottom && label.left >= button.left && label.right <= button.right;
    })).toBe(true);
    await expect(page.locator(".persona-pill-label")).toHaveCSS("opacity", "1");
    await persona.click();
    await expect(page.getByRole("listbox", { name: "Choose answer persona" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "Choose answer persona" })).not.toBeVisible();
  }
  // Reverse direction before the fade completes. Cancelled transitions must
  // leave neither stale compact state nor an invisible model/effort label.
  await page.getByTestId("chat-width").evaluate(async element => {
    for (const width of [600, 340, 600, 340, 600]) {
      element.style.width = `${width}px`;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  });
  await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", "false");
  await expect(page.locator(".model-badge")).not.toHaveAttribute("data-morphing", "true");
  await expect(page.locator(".model-pill-prefix")).toHaveCSS("opacity", "1");
  await expect(page.locator(".model-pill-effort")).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("chat-width").evaluate(element => { element.style.width = "340px"; });
  await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", "true");
  await expect.poll(() => page.locator(".model-badge").evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.id === "model-pill-morph").length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await surface.screenshot({ path: test.info().outputPath("compact-chat.png") });
  await page.getByRole("button", { name: "Chat context: Project", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: /Memory/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByRole("menu", { name: "Choose model" })).toBeVisible();
  expect(errors).toEqual([]);
});
}

test("tabs behave as a browser's: the last one closes the window, and there is never a second blank tab", async ({ page }) => {
  const chat = (n: number, empty = false) => ({ id: String(n).repeat(32), generation: 0, title: empty ? "New chat" : `Discussion ${n}`, empty, kind: "document_chat", projectId: "project", paperId: "paper" });
  let items = [chat(1), chat(2)];
  const deleted: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/chat/conversations")) return route.fulfill({ json: { items, defaultId: items[0].id, limit: 10 } });
    if (url.pathname.endsWith("/chat") && route.request().method() === "DELETE") {
      deleted.push(url.searchParams.get("conversation_id")!);
      items = items.filter(item => !deleted.includes(item.id));
      // The context always holds a chat: deleting its last leaves an empty one.
      if (!items.length) items = [chat(9, true)];
      return route.fulfill({ json: { selectedId: items[0].id, catalog: { items, defaultId: items[0].id, limit: 10 } } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  // Wide enough for three tabs at their readable width.
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "900px"; });
  const tabs = page.getByRole("tab");
  const names = () => tabs.evaluateAll(nodes => nodes.map(node => node.querySelector(".conversation-tab-title")!.getAttribute("title") ?? node.textContent));
  await expect(tabs).toHaveCount(2);
  // "+" opens one blank tab, and a second press has nothing to add.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(tabs).toHaveCount(3);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(tabs).toHaveCount(3);
  // Closing a blank tab leaves nothing behind; its neighbour takes over.
  await page.getByRole("button", { name: "Close New chat", exact: true }).click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /Discussion 2/ })).toHaveAttribute("aria-selected", "true");
  // Closing a chat keeps the window while another tab is open, and the chat in its context's list…
  await page.getByRole("button", { name: /^Close Discussion 2/ }).click();
  await expect(tabs).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Discussion 1/ })).toHaveAttribute("aria-selected", "true");
  let list = await contextList(page);
  await expect(list.locator(".conversation-menu-row > [role=menuitem]")).toHaveText([/^Discussion 1\s*Open$/, /^Discussion 2/]);
  // …and deleting a closed one changes nothing on screen.
  await list.locator(".conversation-menu-row").nth(1).click({ button: "right" });
  await list.getByRole("menuitem", { name: /^Delete Discussion 2/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tabs).toHaveCount(1);
  expect(deleted).toEqual([chat(2).id]);
  // The last tab takes the window with it, and deletes nothing.
  await page.getByRole("button", { name: /^Close Discussion 1/ }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
  expect(deleted).toHaveLength(1);
  // Opened again with every chat closed, it starts on one blank tab.
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs).toHaveAttribute("aria-selected", "true");
  expect(await names()).toEqual(["New chat"]);
  list = await contextList(page);
  await expect(list.locator(".conversation-menu-row")).toHaveText([/^Discussion 1/]);
  // Deleting the last chat from there leaves that one blank tab, not two.
  await list.locator(".conversation-menu-row").click({ button: "right" });
  await list.getByRole("menuitem", { name: /^Delete Discussion 1/ }).click();
  await page.getByRole("dialog").getByRole("button").last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".chat-surface")).toBeVisible();
  await expect(tabs).toHaveCount(1);
  expect(await names()).toEqual(["New chat"]);
  // A blank chat is not listed: the context has nothing to show.
  await page.getByRole("button", { name: /^Chat context:/ }).click();
  await page.getByRole("menuitemradio", { name: /^Project/ }).hover();
  await expect(page.getByRole("menuitemradio", { name: /^Project/ })).toHaveAccessibleName(/0 threads/);
  await expect(page.getByRole("menu", { name: "Project chats" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  // A reopened chat comes back as a tab; closing the blank one then closes nothing else.
  await page.reload();
  await expect(tabs).toHaveCount(1);
  await page.getByRole("button", { name: "Close New chat", exact: true }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
});

test("a context with no room for another chat reopens on the chat closed last, never on a draft", async ({ page }) => {
  const items = Array.from({ length: 10 }, (_, n) => ({ id: String.fromCharCode(97 + n).repeat(32), generation: 0, title: `Discussion ${n + 1}`, empty: false, kind: "document_chat", projectId: "project", paperId: "paper" }));
  let created = 0;
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/chat/conversations")) {
      if (route.request().method() === "POST") created += 1;
      return route.fulfill({ json: { items, defaultId: items[0].id, limit: 10 } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  const tabs = page.getByRole("tab");
  // Close every tab in turn; the last takes the window with it.
  for (let n = 0; n < 10; n += 1) await page.locator(".conversation-tab.active .conversation-tab-close").click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Discussion 10/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /New chat/ })).toHaveCount(0);
  const list = await contextList(page);
  await expect(list.locator(".conversation-menu-row")).toHaveCount(10);
  await expect(list.getByRole("menuitem", { name: /^Discussion 10/ })).toContainText("Open");
  await page.keyboard.press("Escape");
  // "+" has nothing to add here either.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  expect(created).toBe(0);
});

/** A long turn either way, so the transcript scrolls and the turns reach their measure. */
const longTurn = (role: "user" | "assistant", index: number) => ({
  role, createdAt: `2026-10-23T00:00:0${index}Z`, requestId: `turn-${Math.floor(index / 2)}`,
  content: Array.from({ length: 6 }, () => "Batch size changes the tradeoff between progress through the loss landscape and reacting to gradient noise.").join(" "),
});
// 14" and 16" laptops, then 28" and 30" displays, each docked at a few widths and expanded.
for (const [width, height] of [[1512, 982], [1728, 1117], [2560, 1440], [2880, 1620]]) {
test(`the composer is exactly as wide as the turns above it, docked and expanded (${width}×${height})`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: "1".repeat(32), generation: 0, title: "Batch size", empty: false, kind: "document_chat", projectId: "project", paperId: "paper" }],
      defaultId: "1".repeat(32), limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: Array.from({ length: 6 }, (_, i) => longTurn(i % 2 ? "assistant" : "user", i)), images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  await expect(page.locator(".message.assistant").first()).toBeVisible();
  const edges = () => page.locator(".chat-surface").evaluate(surface => {
    const composer = surface.querySelector(":scope > .composer")!.getBoundingClientRect();
    const turns = [...surface.querySelectorAll(".message")].map(turn => turn.getBoundingClientRect());
    return { composer: [composer.left, composer.right], turns: turns.map(turn => [turn.left, turn.right]) };
  });
  const expectAligned = async (label: string) => {
    const { composer, turns } = await edges();
    expect(turns.length, label).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(Math.abs(turn[0] - composer[0]), `left edge, ${label}`).toBeLessThan(0.5);
      expect(Math.abs(turn[1] - composer[1]), `right edge, ${label}`).toBeLessThan(0.5);
    }
  };
  for (const docked of [460, 700, 1100]) {
    await page.getByTestId("chat-width").evaluate((el, docked) => { el.style.width = `${docked}px`; }, docked);
    await expectAligned(`docked at ${docked}px`);
  }
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  // The card is flown to its expanded box; measure where it comes to rest.
  await expect.poll(() => page.locator(".chat-surface").evaluate(card => card.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  await expectAligned("expanded");
  const expanded = await edges();
  // A large display's expanded turns stop at their measure, with margins either side.
  if (width >= 2560) expect(expanded.composer[1] - expanded.composer[0]).toBeCloseTo(1240, 0);
  // The zoom keys size the conversation's text (nothing else here zooms), and
  // the larger turns still keep the composer's edges.
  for (let step = 0; step < 3; step++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: 1 })));
  await expect(page.locator(".message.assistant > .kb-chat-turn").first()).toHaveCSS("zoom", "1.5");
  expect(await page.evaluate(() => localStorage.getItem("delphi.chat-zoom"))).toBe("150");
  await expectAligned("expanded at 150%");
});
}

test("the transcript fades out under the tabs and above the composer alike, hidden outright at each edge", async ({ page }) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: "1".repeat(32), generation: 0, title: "Batch size", empty: false, kind: "document_chat", projectId: "project", paperId: "paper" }],
      defaultId: "1".repeat(32), limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: Array.from({ length: 8 }, (_, i) => longTurn(i % 2 ? "assistant" : "user", i)), images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat");
  const messages = page.locator(".chat-surface > .messages");
  await expect(page.locator(".message.assistant").first()).toBeVisible();
  await messages.evaluate(node => { node.style.scrollBehavior = "auto"; });
  /** How much ink each row of the transcript shows, darkest pixel first, read back from a screenshot. */
  const ink = async () => {
    const box = (await messages.boundingBox())!;
    const shot = await page.screenshot({ clip: box, animations: "disabled" });
    return page.evaluate(async ([png, width, height]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      return Array.from({ length: height }, (_, y) => {
        let darkest = 0;
        for (let x = 0; x < width; x++) darkest = Math.max(darkest, 255 - data[(y * width + x) * 4]);
        return darkest;
      });
    }, [shot.toString("base64"), Math.round(box.width), Math.round(box.height)] as const);
  };
  const fade = await messages.evaluate(node => ["--chat-transcript-fade", "--chat-fade-hold"].map(name => Number.parseFloat(getComputedStyle(node).getPropertyValue(name))));
  const [full, hold] = fade;
  expect(hold).toBeGreaterThan(0);
  // Mid-transcript, text runs across both edges.
  await messages.evaluate(node => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; });
  const rows = await ink();
  const band = (from: number, to: number) => Math.max(...rows.slice(from, to));
  expect(band(0, hold - 1), "hidden under the tabs").toBeLessThan(8);
  expect(band(rows.length - hold + 1, rows.length), "hidden above the composer").toBeLessThan(8);
  expect(band(full + 2, rows.length - full - 2), "read in full between the fades").toBeGreaterThan(150);
  // Scrolled to the end, the last turn clears the bottom fade.
  await messages.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const clear = await messages.evaluate((node, full) => {
    const last = [...node.querySelectorAll(".message")].at(-1)!.getBoundingClientRect();
    return node.getBoundingClientRect().bottom - full - last.bottom;
  }, full);
  expect(clear).toBeGreaterThanOrEqual(0);
});
