import { test, expect, type Page } from "@playwright/test";

/** Sets the column's width and waits out the model pill's morph, so `data-compact` is its settled value. */
async function setColumn(page: Page, width: number) {
  await page.getByTestId("chat-width").evaluate(async (el, width) => {
    el.style.width = `${width}px`;
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
  }, width);
  await expect.poll(() => page.locator(".model-badge").evaluate(el => el.getAnimations({ subtree: true }).some(a => a.id === "model-pill-morph" && a.playState === "running"))).toBe(false);
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
  await expect(page.locator(".composer-input")).toHaveAttribute("aria-placeholder", /^Hint: (press \/side|toggle Plan mode)/);
  // Include the 320px minimum and narrower historical problem widths so
  // increasing the minimum cannot conceal a hover or wrapping regression.
  for (const width of [760, 600, 460, 420, 360, 350, 340, 320, 290, 288, 280, 704, 703, 760]) {
    await setColumn(page, width);
    await expect(page.locator(".model-badge")).toHaveAttribute("data-compact", String(width <= 420));
    await expect(page.locator(".model-badge")).not.toHaveAttribute("data-morphing", "true");
    await expect.poll(async () => page.locator(".conversation-header").evaluate(header => {
      const title = header.querySelector(".conversation-switch")?.getBoundingClientRect();
      const add = header.querySelector(".conversation-new")?.getBoundingClientRect();
      return Boolean(title && add && title.right <= add.left);
    })).toBe(true);
    await expect(page.locator(".conversation-header")).toHaveCSS("flex-wrap", "nowrap");
    const controls = await page.locator(".conversation-header").evaluate(header => {
      const selectors = [".conversation-switch", ".conversation-new", ".conversation-window-controls"];
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
    // A hint too long for one line grows the field instead of being cut off.
    // Measured at rest: a hint rolling in overflows by its own slide.
    await expect.poll(() => page.locator(".composer-editor").evaluate(editor => !editor.getAnimations({ subtree: true }).length && editor.scrollHeight <= editor.clientHeight), `the hint is whole at ${width}px`).toBe(true);
  }
  // A new chat offers no template questions: the mark sits at the lower left, just above the field.
  await expect(page.locator(".chat-empty button")).toHaveCount(await page.locator(".chat-empty .conversation-row").count());
  const markBox = await page.locator(".chat-empty").boundingBox();
  const logoBox = await page.locator(".chat-empty .agent-orbit").boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(logoBox!.x - composerBox!.x).toBeLessThan(32);
  expect(composerBox!.y - (markBox!.y + markBox!.height)).toBeLessThan(60);
  await page.getByTestId("chat-width").evaluate(el => { el.style.width = "340px"; });
  // A title too long for the header is cut with an ellipsis; in the sheet it runs under the pointer.
  await expect(page.locator(".conversation-switch-title")).toHaveCSS("text-overflow", "ellipsis");
  if (count > 1) {
  await page.locator(".conversation-switch-trigger").click();
  const title = page.locator(".conversation-sheet .conversation-row-title").first();
  await expect(title).toHaveClass(/is-long/);
  await title.hover();
  await expect(title.locator(".kb-related-track")).toHaveCSS("animation-name", "kb-related-ticker");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(title.locator(".kb-related-track")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.keyboard.press("Escape");
  }
  for (const width of [280, 320, 340, 420, 500, 600]) {
    await setColumn(page, width);
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
    expect(positions.every((sample, index) => index === 0 || sample[2] >= positions[index - 1][2] - 0.1), `${width} ${JSON.stringify(positions.map(p => p[2].toFixed(1)))}`).toBe(true);
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
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByRole("menu", { name: "Choose model" })).toBeVisible();
  expect(errors).toEqual([]);
});
}

test("Hide closes the window and deletes nothing; deleting the last chat leaves one blank chat", async ({ page }) => {
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
  const title = page.locator(".conversation-switch-trigger");
  await expect(title).toHaveText("Discussion 1");
  await page.getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
  expect(deleted).toEqual([]);
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(title).toHaveText("Discussion 1");
  const remove = async (name: string) => {
    await title.click();
    const row = page.locator(".conversation-sheet .conversation-row", { hasText: name });
    await row.click({ button: "right" });
    await row.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  // Deleting a chat not on screen changes nothing on screen.
  await remove("Discussion 2");
  await expect(title).toHaveText("Discussion 1");
  await remove("Discussion 1");
  expect(deleted).toEqual([chat(2).id, chat(1).id]);
  // One blank chat is left, and with nothing else to list the title opens nothing.
  await expect(title).toHaveText("New chat");
  await expect(title).toBeDisabled();
  await expect(page.getByLabel("New chat", { exact: true })).toBeDisabled();
});

test("a context with no room for another chat reopens on its latest, never on a draft", async ({ page }) => {
  const items = Array.from({ length: 10 }, (_, n) => ({ id: String.fromCharCode(97 + n).repeat(32), generation: 0, title: `Discussion ${n + 1}`, empty: false, kind: "document_chat", projectId: "project", paperId: "paper", lastEngagedAt: new Date(Date.UTC(2026, 9, 1 + n)).toISOString() }));
  let created = 0;
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/chat/conversations")) {
      if (route.request().method() === "POST") created += 1;
      return route.fulfill({ json: { items, defaultId: null, limit: 10 } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: [], images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  await expect(page.locator(".conversation-switch-trigger")).toHaveText("Discussion 10");
  // "+" has nothing to add, and makes nothing.
  await page.getByLabel("New chat", { exact: true }).click();
  await expect(page.locator(".conversation-switch-trigger")).toHaveText("Discussion 10");
  await page.locator(".conversation-switch-trigger").click();
  await expect(page.locator(".conversation-sheet .conversation-row")).toHaveCount(10);
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
  // Expanded, the column is the chat's one measure, with margins either side,
  // and an answer's text as wide as its table.
  const card = await page.locator(".chat-surface").evaluate(surface => surface.getBoundingClientRect().width);
  expect(expanded.composer[1] - expanded.composer[0]).toBeLessThan(card - 100);
  expect(expanded.composer[1] - expanded.composer[0]).toBeCloseTo(910, 0);
  const paragraph = await page.locator(".message.assistant .prose-reading > p").first().evaluate(p => p.getBoundingClientRect().width);
  expect(paragraph).toBeCloseTo(expanded.composer[1] - expanded.composer[0], -1);
  // The zoom keys size the conversation's text (nothing else here zooms), and
  // the larger turns still keep the composer's edges.
  for (let step = 0; step < 3; step++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: 1 })));
  await expect(page.locator(".message.assistant > .kb-chat-turn").first()).toHaveCSS("zoom", "1.5");
  expect(await page.evaluate(() => localStorage.getItem("delphi.chat-zoom"))).toBe("150");
  await expectAligned("expanded at 150%");
});
}

test("the transcript fades out under the header and above the composer alike, hidden outright at each edge", async ({ page }) => {
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
  expect(band(0, hold - 1), "hidden under the header").toBeLessThan(8);
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
