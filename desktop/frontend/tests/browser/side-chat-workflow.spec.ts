import { expect, test, type Page } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";
import { SIDE_CHAT, sideChatExtra } from "../../app/lib/side-chat";

// A side chat against the installed backend, through the real host: the
// reader's rail and the Memory chat widen for it, its questions reach the
// model behind the marker, and nothing of it is kept.
type Workspace = Awaited<ReturnType<typeof subscriptionWorkspace>>;
const VIEWPORT = { width: 1512, height: 900 };
const MARKER = "[Side chat starts here.";
let workspace: Workspace;
test.use({ actionTimeout: 10_000, viewport: VIEWPORT });
test.beforeEach(async ({ context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
});
test.afterEach(async () => { await workspace?.close(); });

async function seed(w: Workspace) {
  const project = await (await w.request("/api/projects", { name: "Optimizers" })).json() as { id: string; slug: string };
  const form = new FormData();
  form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), "Muon.pdf");
  const upload = await fetch(`${w.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: w.cookie, origin: w.origin }, body: form });
  expect(upload.ok).toBe(true);
  const paper = await upload.json() as { id: string; slug: string };
  const query = { scope: "document", project_id: project.id, paper_id: paper.id };
  const chat = await (await w.request("/api/chat/conversations", { ...query, creation_key: "side_workflow" })).json() as { id: string };
  expect(await (await w.request("/api/chat/stream", { ...query, conversation_id: chat.id, prompt: "What does Muon orthogonalize?" })).text()).toContain("done");
  const thread = async () => (await w.request(`/api/chat?${new URLSearchParams({ ...query, conversation_id: chat.id })}`)).json();
  return { reader: `${w.origin}/@workflow/${project.slug}/${paper.slug}?chat=paper`, thread };
}

const composer = (page: Page) => page.locator(".chat-surface .composer-input").first();
const side = (page: Page) => page.getByRole("complementary", { name: "Side chat" });
const sideInput = (page: Page) => side(page).getByRole("textbox", { name: "Side question" });
/** A box's width once nothing in the page is animating. */
async function settledWidth(page: Page, selector: string) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").length), { timeout: 5_000 }).toBe(0);
  return page.locator(selector).first().evaluate(el => Math.round(el.getBoundingClientRect().width));
}
/** Each side question's first model round: input carrying the marker, before any tool result. */
const sideAsks = (w: Workspace) => w.asked.filter(body => JSON.stringify(body.input ?? []).includes(MARKER) && !body.text?.format
  && !body.input.some((item: any) => item.type === "function_call_output"));

async function askSide(page: Page, question: string, answers: number) {
  await sideInput(page).fill(question);
  await page.keyboard.press("Enter");
  await expect(side(page).locator(".side-chat-answer")).toHaveCount(answers);
  await expect(side(page).locator(".side-chat-answer").last()).toContainText(/Subscription workflow|ChatGPT read Memory/);
  await expect(side(page).getByRole("button", { name: "Send side question" })).toBeVisible();
}

test("beside a document, the rail widens for a side chat that shares the thread and keeps nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const { reader, thread } = await seed(workspace);
  const before = await thread();
  await page.goto(reader);
  await expect(page.locator(".chat-surface .messages")).toContainText("What does Muon orthogonalize?");
  const column = await settledWidth(page, ".chat-surface");

  // The pane enters once the column has grown: never as an overlay on the way.
  await page.locator(".chat-surface").evaluate(card => {
    (window as any).__overlaid = false;
    new MutationObserver(() => { if (card.classList.contains("side-overlay")) (window as any).__overlaid = true; })
      .observe(card, { attributes: true, attributeFilter: ["class"] });
  });
  await composer(page).click();
  await page.keyboard.type("/side Why five Newton–Schulz steps?");
  await page.keyboard.press("Enter");
  await expect(side(page).locator(".side-chat-answer")).toContainText("ChatGPT read Memory");
  expect(await page.evaluate(() => (window as any).__overlaid)).toBe(false);
  const wide = await settledWidth(page, ".chat-surface");
  const readerWidth = await settledWidth(page, ".reader-panel");
  // The column grows by the side's width, or as far as leaves the reader its floor.
  expect(readerWidth).toBeGreaterThanOrEqual(372);
  expect(wide - column === sideChatExtra(VIEWPORT.width) || readerWidth <= 373).toBe(true);
  expect(wide).toBeGreaterThan(column);
  // Here the library leaves less than both want, so the reader is at its floor.
  expect(readerWidth).toBeLessThanOrEqual(373);
  const main = await page.locator(".chat-surface > .messages").evaluate(el => Math.round(el.getBoundingClientRect().width));
  expect(main).toBeGreaterThanOrEqual(SIDE_CHAT.mainMin - 24);

  // With the library folded there is room for both: the column grows by exactly the side's width.
  // Clicking into the reader folds the library, as when reading.
  await page.locator(".reader-panel").click({ position: { x: 12, y: 500 } });
  const roomy = await settledWidth(page, ".chat-surface");
  expect(roomy - column).toBe(sideChatExtra(VIEWPORT.width));
  expect(await settledWidth(page, ".reader-panel")).toBeGreaterThan(372);

  await askSide(page, "And why a quintic?", 2);
  await askSide(page, "Summarize this side chat.", 3);

  // Each side question went out behind the marker, after the main thread, with the earlier side turns.
  const asks = sideAsks(workspace);
  expect(asks).toHaveLength(3);
  const last = asks.at(-1).input.filter((item: any) => typeof item.content === "string").map((item: any) => item.content);
  const marker = last.findIndex((text: string) => text.startsWith(MARKER));
  expect(marker).toBeGreaterThan(0);
  expect(last.slice(0, marker).some((text: string) => text.startsWith("What does Muon orthogonalize?"))).toBe(true);
  expect(last.slice(marker + 1)).toEqual(expect.arrayContaining(["Why five Newton–Schulz steps?", "And why a quintic?", "Summarize this side chat."]));
  expect(last.at(-1)).toBe("Summarize this side chat.");
  expect(asks.at(-1).instructions).toContain("# This is a side chat");

  // Closed, the rail goes back to its own width, and the thread is as it was.
  await side(page).getByRole("button", { name: "Close side chat" }).click();
  await expect(side(page)).toHaveCount(0);
  expect(await settledWidth(page, ".chat-surface")).toBe(column);
  expect(await thread()).toEqual(before);
  await page.reload();
  await expect(page.locator(".chat-surface .messages")).toContainText("What does Muon orthogonalize?");
  await expect(page.locator(".chat-surface .messages")).not.toContainText("Summarize this side chat");
  await expect(side(page)).toHaveCount(0);
});

test("the Memory chat widens for a side chat too, and gives the width back", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${workspace.origin}/memory?ask=1`);
  const card = ".kb-chat-rail";
  await expect(page.locator(card)).toBeVisible();
  const column = await settledWidth(page, card);
  await composer(page).click();
  await page.keyboard.type("/side");
  await page.keyboard.press("Enter");
  await expect(side(page)).toBeVisible();
  const wide = await settledWidth(page, card);
  expect(wide - column).toBe(sideChatExtra(VIEWPORT.width));

  await askSide(page, "What is in my Memory about attention?", 1);
  expect(sideAsks(workspace)).toHaveLength(1);
  await sideInput(page).press("Escape");
  await expect(side(page)).toHaveCount(0);
  expect(await settledWidth(page, card)).toBe(column);
  const conversations = await (await workspace.request("/api/chat/conversations?scope=general")).json() as { items: { empty?: boolean }[] };
  expect(conversations.items.every(item => item.empty !== false)).toBe(true);
});
