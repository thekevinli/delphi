import { expect, test, type Page } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";

// The Memory chat page against the installed backend: the hand-off from the
// composer, the chat it makes and the reader a citation opens are real; only
// the model is a fixture.
type Workspace = Awaited<ReturnType<typeof subscriptionWorkspace>>;
let workspace: Workspace;
test.use({ actionTimeout: 10_000, viewport: { width: 1512, height: 900 } });
test.beforeEach(async ({ context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
});
test.afterEach(async () => { await workspace?.close(); });

const memoryChats = async () => (await (await workspace.request("/api/chat/conversations?scope=general")).json()).items as { id: string; empty?: boolean; title: string }[];
const list = (page: Page) => page.getByRole("navigation", { name: "Memory chats" });
const chat = (page: Page) => page.locator(".kb-memory-chat");

test("a question asked from Health is answered once, in a new chat on the Memory chat page", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${workspace.origin}/memory/health`);
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  const composer = page.locator(".kb-composer-card");
  await composer.getByRole("textbox").fill("What does my Memory say about attention?");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/memory\/chat\?conversation=/);
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(chat(page).locator(".message.user")).toContainText("What does my Memory say about attention?");
  await expect(chat(page).locator(".message.assistant")).toContainText("WORKFLOW-RECEIPT-37", { timeout: 30_000 });
  // One Memory chat holds it, listed under Today and open.
  const id = new URL(page.url()).searchParams.get("conversation");
  await expect.poll(async () => (await memoryChats()).filter(item => !item.empty).map(item => item.id)).toEqual([id]);
  await expect(list(page).getByRole("region", { name: "Today" }).locator(".conversation-row.is-current")).toHaveAttribute("data-conversation", id!);
  // A reload shows the chat and asks nothing again.
  const asked = workspace.asked.length;
  await page.reload();
  await expect(chat(page).locator(".message.assistant")).toContainText("WORKFLOW-RECEIPT-37");
  await page.waitForTimeout(1000);
  expect(workspace.asked.length).toBe(asked);
  // New chat starts a blank one; the asked chat stays in the list.
  await list(page).getByRole("button", { name: "New chat", exact: true }).click();
  await expect(chat(page).locator(".message")).toHaveCount(0);
  await expect(list(page).locator(".conversation-row.is-current")).toContainText("New chat");
  await expect(list(page).locator(`[data-conversation="${id}"]`)).toBeVisible();
});

test("a citation in a Memory answer opens its document with the chat closed, and Back returns to the chat", async ({ page }) => {
  test.setTimeout(90_000);
  const project = await (await workspace.request("/api/projects", { name: "Attention" })).json() as { id: string; slug: string };
  const form = new FormData();
  form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), "Omni.pdf");
  const upload = await fetch(`${workspace.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: workspace.cookie, origin: workspace.origin }, body: form });
  expect(upload.ok).toBe(true);
  const paper = await upload.json() as { id: string; slug: string; title: string };
  workspace.answer(`The receipt is stated in (${paper.title}, p. 1).`);

  await page.goto(`${workspace.origin}/memory/chat`);
  await chat(page).getByRole("textbox").fill("Where is the receipt stated?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const citation = chat(page).locator(".message.assistant").getByRole("link", { name: `${paper.title} · p. 1` });
  await expect(citation).toBeVisible({ timeout: 30_000 });
  const asked = page.url();
  await citation.click();
  await expect(page).toHaveURL(new RegExp(`/@workflow/${project.slug}/${paper.slug}`));
  expect(new URL(page.url()).searchParams.get("chat")).toBeNull();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(asked);
  await expect(chat(page).locator(".message.user")).toContainText("Where is the receipt stated?");
});
