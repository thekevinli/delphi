import { expect, test, type Page, type Route } from "@playwright/test";
import { SIDE_CHAT, sideChatExtra } from "../../app/lib/side-chat";
import { rightColumnScale } from "../../app/lib/right-column";

// The side chat (`/side`) in the real chat panel: the command, the pane's
// geometry at every width, what each question sends, and that its turns live
// with their tab and nowhere else.
const VIEWPORT = { width: 1512, height: 900 };
const chats = {
  document: [
    { id: "d".repeat(32), title: "How does Muon orthogonalize?" },
    { id: "c".repeat(32), title: "Newton–Schulz coefficients" },
  ],
  general: [
    { id: "e".repeat(32), title: "Muon write-ups in my Memory" },
    { id: "f".repeat(32), title: "Shampoo against Muon" },
  ],
};
const history = [
  { role: "user", content: "Compare the Muon write-ups in my Memory.", requestId: "r1" },
  { role: "assistant", content: "Muon replaces each 2D update with its nearest semi-orthogonal matrix.", requestId: "r1" },
];
const sse = (...events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

type SideRequest = { body: Record<string, unknown> };
type Answer = (route: Route, request: SideRequest) => Promise<void> | void;

async function open(page: Page, { scope = "document", width = 820, answer }: { scope?: "document" | "general"; width?: number; answer?: Answer } = {}) {
  const sent: SideRequest[] = [];
  const main: unknown[] = [];
  await page.setViewportSize(VIEWPORT);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const items = chats[url.searchParams.get("scope") === "general" ? "general" : "document"]
      .map((chat, index) => ({ ...chat, generation: 0, empty: false, lastEngagedAt: new Date(Date.now() - index * 3600_000).toISOString() }));
    if (url.pathname.endsWith("/chat/side")) {
      const request = { body: route.request().postDataJSON() as Record<string, unknown> };
      sent.push(request);
      if (answer) return answer(route, request);
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse(
        { type: "delta", text: `Side answer ${sent.length}.` }, { type: "done", trace: null, sources: [] },
      ) });
    }
    if (url.pathname.endsWith("/chat/stream")) { main.push(route.request().postDataJSON()); return route.abort(); }
    if (url.pathname.endsWith("/chat/conversations")) return route.fulfill({ json: { items, defaultId: items[0].id, limit: 10 } });
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: { messages: history, images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`/tests/browser/harness.html?responsive-chat&closable&width=${width}${scope === "general" ? "&scope=general" : ""}`);
  await expect(page.locator(".chat-surface .messages")).toContainText("semi-orthogonal");
  return { sent, main };
}

const composer = (page: Page) => page.locator(".chat-surface .composer-input").first();
const side = (page: Page) => page.getByRole("complementary", { name: "Side chat" });
const sideInput = (page: Page) => side(page).getByRole("textbox", { name: "Side question" });
const header = (page: Page) => page.locator(".conversation-header");
const setWidth = (page: Page, width: number) => page.getByTestId("chat-width").evaluate(async (el, width) => {
  el.style.width = `${width}px`;
  for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
}, width);

/** The card, the side pane and the main chat's messages, once the pane has finished entering. */
async function geometry(page: Page) {
  await expect.poll(() => side(page).evaluate(el => el.getAnimations().filter(a => a.playState === "running").length)).toBe(0);
  return page.locator(".chat-surface").evaluate(card => {
    const box = (el: Element | null) => el!.getBoundingClientRect();
    const messages = box(card.querySelector(":scope > .messages")), pane = box(card.querySelector(".side-chat")), surface = box(card);
    const head = box(card.querySelector(".conversation-header"));
    return {
      card: Math.round(surface.width), side: Math.round(pane.width), mainRight: Math.round(messages.right),
      sideLeft: Math.round(pane.left), sideTop: Math.round(pane.top), headBottom: Math.round(head.bottom),
      headRight: Math.round(head.right), cardRight: Math.round(surface.right),
      overlay: card.classList.contains("side-overlay"),
    };
  });
}

async function openSide(page: Page) {
  await composer(page).click();
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(side(page)).toBeVisible();
  await expect(sideInput(page)).toBeFocused();
}

for (const scope of ["document", "general"] as const) {
  test.describe(`side chat · ${scope}`, () => {
    test("/ offers the side chat; Enter opens it, empty composer and all", async ({ page }) => {
      const { sent, main } = await open(page, { scope });
      await composer(page).click();
      await page.keyboard.type("/si");
      const menu = page.getByRole("listbox", { name: "Commands" });
      await expect(menu.getByRole("option")).toHaveText(/\/side.*Temporary, shares this chat’s context/);
      await page.keyboard.press("Enter");
      await expect(side(page)).toBeVisible();
      await expect(composer(page)).toHaveText("");
      await expect(side(page)).toContainText("Temporary, shares this chat’s context");
      expect(sent).toHaveLength(0);
      expect(main).toHaveLength(0);
    });

    test("two side questions: the second carries the first, with the main composer's picks", async ({ page }) => {
      const { sent, main } = await open(page, { scope });
      await openSide(page);
      await sideInput(page).fill("Why a quintic?");
      await page.keyboard.press("Enter");
      await expect(side(page).locator(".side-chat-answer").first()).toContainText("Side answer 1.");
      await sideInput(page).fill("Summarize this side chat.");
      await side(page).getByRole("button", { name: "Send side question" }).click();
      await expect(side(page).locator(".side-chat-answer").nth(1)).toContainText("Side answer 2.");

      expect(sent).toHaveLength(2);
      const [first, second] = sent.map(request => request.body);
      expect(first.conversation_id).toBe(chats[scope][0].id);
      expect(first.scope).toBe(scope);
      expect(first.side_turns).toEqual([]);
      expect(second.side_turns).toEqual([{ question: "Why a quintic?", answer: "Side answer 1." }]);
      expect(second.prompt).toBe("Summarize this side chat.");
      expect(typeof second.model).toBe("string");
      expect(second.model).toBeTruthy();
      expect(second.reasoning_effort).toBeTruthy();
      // Nothing a side question may not carry, and nothing reached the main thread.
      for (const key of ["request_id", "desktop_mode", "mode", "engagement_id", "selected_text"]) expect(second).not.toHaveProperty(key);
      expect(main).toHaveLength(0);
      await expect(page.locator(".chat-surface > .messages")).not.toContainText("Side answer");
    });
  });
}

test("/side with a question asks it at once; /usr/bin is an ordinary message", async ({ page }) => {
  const { sent, main } = await open(page);
  await composer(page).click();
  await page.keyboard.type("/side What is a Newton–Schulz step?");
  await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(side(page).locator(".side-chat-question")).toHaveText("What is a Newton–Schulz step?");
  await expect(side(page).locator(".side-chat-answer")).toContainText("Side answer 1.");
  expect(sent.map(request => request.body.prompt)).toEqual(["What is a Newton–Schulz step?"]);
  expect(main).toHaveLength(0);

  await side(page).getByRole("button", { name: "Close side chat" }).click();
  await expect(side(page)).toHaveCount(0);
  await composer(page).click();
  await page.keyboard.type("/usr/bin is missing");
  await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => main.length).toBe(1);
  expect((main[0] as { prompt: string }).prompt).toBe("/usr/bin is missing");
  await expect(side(page)).toHaveCount(0);
});

test("Escape dismisses the command menu, and Tab takes it", async ({ page }) => {
  await open(page);
  await composer(page).click();
  await page.keyboard.type("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer(page)).toHaveText("/");
  // Cleared and typed again, it is offered again.
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(side(page)).toBeVisible();
});

test("the docked panel splits 460/360, drags between its bounds and resets on double-click", async ({ page }) => {
  await open(page);
  const scale = rightColumnScale(VIEWPORT.width);
  const opening = sideChatExtra(VIEWPORT.width);
  await openSide(page);
  let at = await geometry(page);
  expect(at.overlay).toBe(false);
  expect(at.side).toBe(opening);
  expect(at.card - at.side).toBeGreaterThanOrEqual(Math.round(SIDE_CHAT.mainMin * scale));
  // The main chat ends where the side begins; the header spans both, and the side starts under it.
  expect(at.mainRight).toBeLessThanOrEqual(at.sideLeft);
  expect(at.headRight).toBe(at.cardRight);
  expect(Math.abs(at.sideTop - at.headBottom)).toBeLessThanOrEqual(1);

  const divider = page.getByRole("separator", { name: "Resize side chat" });
  const drag = async (dx: number) => {
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await drag(-600);
  at = await geometry(page);
  expect(at.side).toBe(at.card - Math.round(SIDE_CHAT.mainMin * scale));
  await drag(600);
  at = await geometry(page);
  expect(at.side).toBe(Math.round(SIDE_CHAT.min * scale));
  await divider.dblclick();
  at = await geometry(page);
  expect(at.side).toBe(opening);
});

test("a panel too narrow for both lays the side chat over the main one", async ({ page }) => {
  await open(page, { width: 460 });
  await openSide(page);
  const at = await geometry(page);
  expect(at.overlay).toBe(true);
  expect(at.side).toBeLessThan(at.card);
  expect(at.side).toBeGreaterThanOrEqual(Math.round(SIDE_CHAT.min * rightColumnScale(VIEWPORT.width)));
  await expect(page.locator(".side-chat-ghost")).toBeVisible();
  // The ghost is a strip of the main chat in view, never a way to lose the side chat.
  await page.locator(".side-chat-ghost").click({ force: true });
  await expect(side(page)).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize side chat" })).toHaveCount(0);
});

test("nothing overlaps at 320px", async ({ page }) => {
  await open(page, { width: 320 });
  await openSide(page);
  await sideInput(page).fill("Why a quintic?");
  await page.keyboard.press("Enter");
  await expect(side(page).locator(".side-chat-answer")).toContainText("Side answer 1.");
  const spill = await side(page).evaluate(pane => {
    const bounds = pane.getBoundingClientRect();
    return [...pane.querySelectorAll("*")].filter(el => {
      const box = el.getBoundingClientRect();
      return box.width && (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5);
    }).map(el => el.className);
  });
  expect(spill).toEqual([]);
  const send = (await side(page).getByRole("button", { name: /side question|side answer/ }).boundingBox())!;
  const input = (await sideInput(page).boundingBox())!;
  expect(input.x + input.width).toBeLessThanOrEqual(send.x + 0.5);
});

test("expanded, the card grows by the side's width and Escape closes only the side chat", async ({ page }) => {
  await open(page);
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  const card = page.locator(".chat-surface");
  const settled = async () => {
    await expect.poll(() => card.evaluate(el => el.getAnimations({ subtree: false }).filter(a => a.playState === "running").length)).toBe(0);
    return card.evaluate(el => Math.round(el.getBoundingClientRect().width));
  };
  const alone = await settled();
  await openSide(page);
  const withSide = await settled();
  expect(withSide).toBe(Math.min(alone + sideChatExtra(VIEWPORT.width, "expanded"), VIEWPORT.width - 48));
  const at = await geometry(page);
  expect(at.side).toBe(sideChatExtra(VIEWPORT.width, "expanded"));

  await sideInput(page).press("Escape");
  await expect(side(page)).toHaveCount(0);
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  expect(await settled()).toBe(alone);
});

test("Stop ends a side answer; a failure offers Retry, which asks again", async ({ page }) => {
  let release: () => void = () => {};
  let calls = 0;
  await open(page, {
    answer: async route => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return route.abort().catch(() => {});
      }
      if (calls === 2) return route.fulfill({ status: 503, json: { detail: "The provider is busy" } });
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse({ type: "delta", text: "Recovered." }, { type: "done" }) });
    },
  });
  await openSide(page);
  await sideInput(page).fill("Why a quintic?");
  await page.keyboard.press("Enter");
  const stop = side(page).getByRole("button", { name: "Stop side answer" });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(side(page).locator(".side-chat-error")).toContainText("Stopped.");
  release();

  await side(page).getByRole("button", { name: "Retry" }).click();
  await expect(side(page).locator(".side-chat-error")).toContainText("Request failed: The provider is busy");
  await side(page).getByRole("button", { name: "Retry" }).click();
  await expect(side(page).locator(".side-chat-answer")).toContainText("Recovered.");
  await expect(side(page).locator(".side-chat-turn")).toHaveCount(1);
  await expect(side(page).locator(".side-chat-error")).toHaveCount(0);
});

test("a side chat stays with its tab, and closing the tab discards it", async ({ page }) => {
  await open(page);
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await openSide(page);
  await sideInput(page).fill("Why a quintic?");
  await page.keyboard.press("Enter");
  await expect(side(page).locator(".side-chat-answer")).toContainText("Side answer 1.");
  await sideInput(page).fill("half-typed");

  const [first, second] = chats.document;
  await header(page).getByRole("tab", { name: new RegExp(second.title) }).click();
  await expect(side(page)).toHaveCount(0);
  await header(page).getByRole("tab", { name: new RegExp(first.title) }).click();
  await expect(side(page).locator(".side-chat-answer")).toContainText("Side answer 1.");
  await expect(sideInput(page)).toHaveValue("half-typed");

  // Closed from behind, then brought back from the chat list: no side chat.
  await header(page).getByRole("tab", { name: new RegExp(second.title) }).click();
  const closing = header(page).locator(".conversation-tab", { hasText: first.title });
  await closing.hover();
  await closing.getByRole("button", { name: `Close ${first.title}` }).click();
  await expect(header(page).getByRole("tab", { name: new RegExp(first.title) })).toHaveCount(0);
  const context = header(page).getByRole("button", { name: /^Chat context:/ });
  await context.click();
  await page.getByRole("menuitemradio", { name: /^Project/ }).hover();
  await page.getByRole("menu", { name: "Project chats", exact: true }).getByRole("menuitem", { name: new RegExp(`^${first.title}`) }).click();
  await expect(header(page).getByRole("tab", { selected: true })).toContainText(first.title);
  await expect(side(page)).toHaveCount(0);
});

test("/side with a question while a side answer streams is asked once that answer ends", async ({ page }) => {
  let release: () => void = () => {};
  let calls = 0;
  const { sent, main } = await open(page, {
    answer: async route => {
      calls += 1;
      if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse({ type: "delta", text: `Answer ${calls}.` }, { type: "done" }) }).catch(() => {});
    },
  });
  await openSide(page);
  await sideInput(page).fill("first");
  await page.keyboard.press("Enter");
  await expect(side(page).getByRole("button", { name: "Stop side answer" })).toBeVisible();
  await composer(page).click();
  await page.keyboard.type("/side second");
  await page.keyboard.press("Enter");
  release();
  await expect(side(page).locator(".side-chat-question")).toHaveText(["first", "second"]);
  await expect(side(page).locator(".side-chat-answer").nth(1)).toContainText("Answer 2.");
  expect(sent.map(request => request.body.prompt)).toEqual(["first", "second"]);
  expect(sent[1].body.side_turns).toEqual([{ question: "first", answer: "Answer 1." }]);
  expect(main).toHaveLength(0);
});

test("an edited message that starts with /side is saved, not taken as the command", async ({ page }) => {
  const { main } = await open(page);
  await page.locator(".chat-surface .messages .message-edit").first().click({ force: true });
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/side why?");
  await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => main.length).toBe(1);
  expect((main[0] as { prompt: string }).prompt).toBe("/side why?");
  await expect(side(page)).toHaveCount(0);
});

test("Escape in the side chat is its own: it clears a typed question, then closes, and the card stays expanded", async ({ page }) => {
  await open(page);
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await openSide(page);
  await sideInput(page).fill("half a question");
  await page.keyboard.press("Escape");
  await expect(sideInput(page)).toHaveValue("");
  await expect(side(page)).toBeVisible();
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
  // From any control in it, too.
  await side(page).getByRole("button", { name: "Close side chat" }).focus();
  await page.keyboard.press("Escape");
  await expect(side(page)).toHaveCount(0);
  await expect(page.getByTestId("fullscreen")).toHaveText("true");
});

test("Retry and the suggestion keep what the reader is typing in the side input", async ({ page }) => {
  let calls = 0;
  await open(page, {
    answer: route => {
      calls += 1;
      return calls === 1
        ? route.fulfill({ status: 503, json: { detail: "busy" } })
        : route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse({ type: "delta", text: "Fine now." }, { type: "done" }) });
    },
  });
  await openSide(page);
  await side(page).getByRole("button", { name: "Explain the last answer more simply" }).click();
  await expect(side(page).locator(".side-chat-error")).toContainText("busy");
  await sideInput(page).fill("my next question");
  await side(page).getByRole("button", { name: "Retry" }).click();
  await expect(side(page).locator(".side-chat-answer")).toContainText("Fine now.");
  await expect(sideInput(page)).toHaveValue("my next question");
});
