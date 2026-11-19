import { expect, test, type Page } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";

// The reader's chat switcher against the installed backend: chats, deleting
// and the address are real; only the model is a fixture.
type Workspace = Awaited<ReturnType<typeof subscriptionWorkspace>>;
type Chat = { id: string; title: string; generation: number };
let workspace: Workspace;
test.use({ actionTimeout: 10_000, viewport: { width: 1600, height: 900 } });
test.beforeEach(async ({ context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
});
test.afterEach(async () => { workspace.holdChat(false); await workspace?.close(); });

/** A project with one document, and chats with something said in each, named as a reader would. */
async function seed(w: Workspace, chats: { document: string[]; general: string[] }) {
  const project = await (await w.request("/api/projects", { name: "Scaling" })).json() as { id: string; slug: string };
  const form = new FormData();
  form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), "Omni.pdf");
  const upload = await fetch(`${w.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: w.cookie, origin: w.origin }, body: form });
  expect(upload.ok).toBe(true);
  const paper = await upload.json() as { id: string; slug: string };
  const made: Record<"document" | "general", Chat[]> = { document: [], general: [] };
  for (const scope of ["document", "general"] as const) {
    const query: Record<string, string> = scope === "general" ? { scope } : { scope, project_id: project.id, paper_id: paper.id };
    for (const [index, title] of chats[scope].entries()) {
      const chat = await (await w.request("/api/chat/conversations", { ...query, creation_key: `${scope}_${index}` })).json() as Chat;
      expect(await (await w.request("/api/chat/stream", { ...query, conversation_id: chat.id, prompt: title })).text()).toContain("done");
      const listed = await catalog(w, query);
      const generation = listed.find(item => item.id === chat.id)!.generation;
      const renamed = await w.request(`/api/chat/conversations/${chat.id}`, { title, generation }, { method: "PATCH" });
      expect(renamed.ok).toBe(true);
      made[scope].push({ ...chat, title });
    }
  }
  return { project, paper, chats: made, reader: `${w.origin}/@workflow/${project.slug}/${paper.slug}` };
}
async function catalog(w: Workspace, query: Record<string, string>) {
  return (await (await w.request(`/api/chat/conversations?${new URLSearchParams(query)}`)).json()).items as Chat[];
}

const header = (page: Page) => page.locator(".conversation-header");
const title = (page: Page) => header(page).locator(".conversation-switch-trigger");
const sheet = (page: Page) => page.getByRole("menu", { name: "Chats on this document" });
const conversationInUrl = (page: Page) => new URL(page.url()).searchParams.get("conversation");
/** The two clicks that switch: the title, then a chat. */
async function switchTo(page: Page, name: string) {
  await title(page).click();
  await sheet(page).getByRole("menuitem", { name: new RegExp(`^${name.replace(/[?]/g, "\\?")}`) }).click();
  await expect(title(page)).toHaveText(name);
}

test("a reader switches between a document's chats in two clicks, starts one, asks in it and deletes another", async ({ page }) => {
  test.setTimeout(150_000);
  const { chats, reader, project, paper } = await seed(workspace, {
    document: ["Who are the core contributors?", "How is the multi-stage design split?", "What does the streaming runtime cost?"],
    general: ["What do I know about speculative decoding?"],
  });
  const documentQuery = { scope: "document", project_id: project.id, paper_id: paper.id };
  await page.goto(`${reader}?chat=paper`);
  // The document's latest chat opens, and only this document's chats are offered: Memory is asked on its own page.
  const opened = chats.document[2].title;
  await expect(title(page)).toHaveText(opened);
  await title(page).click();
  await expect(sheet(page).locator(".conversation-row")).toHaveCount(3);
  await expect(sheet(page)).not.toContainText("speculative decoding");
  await expect(sheet(page).locator(".conversation-row.is-current")).toContainText(opened);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Chat context/ })).toHaveCount(0);

  const other = chats.document[0];
  await switchTo(page, other.title);
  // The keyboard stays on the title, ready to switch again.
  await expect(title(page)).toBeFocused();
  await expect.poll(() => conversationInUrl(page)).toBe(other.id);
  await expect(page.locator(".message.user").first()).toContainText(other.title);
  // A reload reopens the chat on screen.
  await page.reload();
  await expect(title(page)).toHaveText(other.title);

  // + starts a new chat offering the latest two others; asking names it.
  await header(page).getByLabel("New chat", { exact: true }).click();
  await expect(title(page)).toHaveText("New chat");
  const earlier = page.getByRole("region", { name: "Earlier chats" });
  await expect(earlier.locator(".conversation-row")).toHaveCount(2);
  await expect(earlier).not.toContainText("Summarize this paper");
  const composer = page.locator(".chat-surface").getByRole("textbox");
  await expect(composer).toBeFocused();
  await composer.fill("Summarize the split again.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await expect.poll(async () => (await catalog(workspace, documentQuery)).length, { timeout: 30_000 }).toBe(4);
  await expect(header(page).getByLabel("New chat", { exact: true })).toBeEnabled({ timeout: 30_000 });

  // Delete, from a row's ⋮, asks first and then removes the chat from the library.
  await title(page).click();
  const row = sheet(page).locator(".conversation-row", { hasText: "How is the multi-stage design split?" });
  await row.hover();
  await row.getByRole("menuitem", { name: /^Options for How is the multi-stage/ }).click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation" });
  await dialog.getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await catalog(workspace, documentQuery)).map(item => item.id)).not.toContain(chats.document[1].id);
  await title(page).click();
  await expect(sheet(page).locator(".conversation-row")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Plan is drawn in the composer's row; Chat, the default, is only announced.
  const mode = page.locator(".chat-surface .composer-mode-label");
  await expect(mode).toHaveText("Chat");
  await expect(mode.locator(".composer-mode-tag")).toHaveCount(0);
  await composer.press("Shift+Tab");
  await expect(mode.locator(".composer-mode-tag")).toHaveText("Plan");
  await expect(mode.locator(".composer-mode-tag")).toBeVisible();
  await composer.press("Shift+Tab");
  await expect(mode).toHaveText("Chat");

  // Expand and Hide are buttons of their own.
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.locator(".kb-chat-rail.is-fullscreen")).toBeVisible();
  await header(page).getByRole("button", { name: "Collapse chat", exact: true }).click();
  await expect(page.locator(".kb-chat-rail.is-fullscreen")).toHaveCount(0);
  await header(page).getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
});

test("a chat left answering shows it on the title and in the sheet, not only on screen", async ({ page }) => {
  test.setTimeout(120_000);
  const { reader } = await seed(workspace, { document: ["Who are the core contributors?", "How is the multi-stage design split?"], general: [] });
  await page.goto(`${reader}?chat=paper`);
  await switchTo(page, "Who are the core contributors?");
  workspace.holdChat(true);
  await page.locator(".chat-surface").getByRole("textbox").fill("Keep answering.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  await switchTo(page, "How is the multi-stage design split?");
  await expect(title(page).getByRole("img", { name: "Another chat is answering" })).toBeVisible();
  await title(page).click();
  const row = sheet(page).locator(".conversation-row", { hasText: "Who are the core contributors?" });
  await expect(row.getByRole("img", { name: "Answering" })).toBeVisible();
  // The mark sits after the title, before the time, so titles start in one column.
  const [name, mark, when] = await Promise.all([".conversation-row-title", ".conversation-activity", "time"].map(selector =>
    row.locator(selector).evaluate(node => node.getBoundingClientRect().left)));
  expect(name).toBeLessThan(mark);
  expect(mark).toBeLessThan(when);
});

test("a new chat offers its earlier chats first, topped up with openers, all in line with the composer", async ({ page }) => {
  test.setTimeout(120_000);
  const { reader } = await seed(workspace, { document: [], general: [] });
  await page.goto(`${reader}?chat=paper`);
  // Nothing asked yet: both openers.
  const offered = page.getByRole("region", { name: "Suggested questions" });
  await expect(offered.locator(".conversation-row")).toHaveText(["Summarize this paper", "Connect to this project"]);
  // The mark and the openers start where the composer does.
  const left = (selector: string) => page.locator(`.chat-surface ${selector}`).first().evaluate((node) => Math.round(node.getBoundingClientRect().left));
  const edge = await left(".composer");
  expect(await left(".agent-orbit img")).toBe(edge);
  expect(await left(".conversation-earlier")).toBe(edge);
  // An opener is a question asked.
  await offered.getByRole("button", { name: "Summarize this paper" }).click();
  await expect(page.locator(".message.user").first()).toContainText("Give me the TL;DR of this document.");
  await expect(page.locator(".message.assistant").first()).not.toBeEmpty({ timeout: 30_000 });
  await expect(header(page).getByLabel("New chat", { exact: true })).toBeEnabled({ timeout: 30_000 });
  // One earlier chat leaves one row for an opener.
  await header(page).getByLabel("New chat", { exact: true }).click();
  const earlier = page.getByRole("region", { name: "Earlier chats" });
  await expect(earlier.locator(".conversation-row")).toHaveCount(2);
  await expect(earlier.locator(".conversation-row").first()).not.toHaveClass(/is-opener/);
  await expect(earlier.locator(".conversation-row.is-opener")).toHaveText("Summarize this paper");
});
