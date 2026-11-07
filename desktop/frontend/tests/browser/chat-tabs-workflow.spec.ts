import { expect, test, type Page } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";

// The reader's chat strip against the installed backend: chats, their
// contexts, closing, deleting and the address are real; only the model is a fixture.
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
const tabs = (page: Page) => header(page).getByRole("tab");
const contextButton = (page: Page) => header(page).getByRole("button", { name: /^Chat context:/ });
/** Opens the context menu and points at a context, which shows its chats. */
async function pointAt(page: Page, label: "Project" | "Memory") {
  if (await contextButton(page).getAttribute("aria-expanded") !== "true") await contextButton(page).click();
  // Pointed at once the roll has come to rest: a row still sliding into place
  // would put another context under the pointer first.
  await expect.poll(() => page.locator(".conversation-scope-roll").evaluate(roll => roll.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  await header(page).getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).hover();
  const list = page.getByRole("menu", { name: `${label} chats`, exact: true });
  await expect(list).toBeVisible();
  return list;
}

test("a reader moves between Project and Memory chats from the context menu, closes, reopens and deletes them", async ({ page }) => {
  test.setTimeout(150_000);
  const { chats, reader, project, paper } = await seed(workspace, {
    document: ["Who are the core contributors?", "How is the multi-stage design split?", "What does the streaming runtime cost?"],
    general: ["What do I know about speculative decoding?", "Which KV cache strategies appear across my papers?"],
  });
  const documentQuery = { scope: "document", project_id: project.id, paper_id: paper.id };
  await page.goto(`${reader}?chat=paper`);
  await expect(tabs(page)).not.toHaveCount(0);
  await expect(contextButton(page)).toHaveAccessibleName("Chat context: Project");

  // Each context is counted, and pointing at one lists its chats, the one on screen marked Open.
  await contextButton(page).click();
  await expect(header(page).getByRole("menuitemradio", { name: /^Project/ })).toHaveAccessibleName(/3 threads/);
  await expect(header(page).getByRole("menuitemradio", { name: /^Memory/ })).toHaveAccessibleName(/2 threads/);
  const projectList = await pointAt(page, "Project");
  await expect(projectList.getByRole("menuitem")).toHaveCount(3);
  const current = await tabs(page).and(page.locator("[aria-selected=true]")).getAttribute("title");
  await expect(projectList.getByRole("menuitem", { name: new RegExp(`^${current!.split(" · ")[0].replace(/[?]/g, "\\?")}`) })).toContainText("Open");

  // A Memory chat opens in Memory, as a tab, and the address says so.
  const memoryList = await pointAt(page, "Memory");
  await memoryList.getByRole("menuitem", { name: /^Which KV cache strategies/ }).click();
  await expect(contextButton(page)).toHaveAccessibleName("Chat context: Memory");
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("Which KV cache strategies");
  await expect.poll(() => new URL(page.url()).searchParams.get("chat")).toBe("general");
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).toBe(chats.general[1].id);
  await expect(page.getByRole("menu", { name: "Memory chats" })).toHaveCount(0);

  // And back: a Project chat opens in Project.
  await (await pointAt(page, "Project")).getByRole("menuitem", { name: /^What does the streaming runtime cost/ }).click();
  await expect(contextButton(page)).toHaveAccessibleName("Chat context: Project");
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("What does the streaming runtime cost");
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).toBe(chats.document[2].id);

  // The docked rail keeps one tab at a readable width; expanded, every open chat is a tab.
  await expect(tabs(page)).toHaveCount(1);
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(tabs(page)).toHaveCount(3);
  // A tab not on screen closes from its cross; the chat stays in the list,
  // stays closed across a reload, and its row brings it back.
  const closing = header(page).locator(".conversation-tab", { hasText: "How is the multi-stage design split?" });
  await closing.hover();
  await closing.getByRole("button", { name: /^Close How is the multi-stage/ }).click();
  await expect(header(page).getByRole("tab", { name: /multi-stage/ })).toHaveCount(0);
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("What does the streaming runtime cost");
  await expect(tabs(page)).toHaveCount(2);
  await expect((await pointAt(page, "Project")).getByRole("menuitem", { name: /^How is the multi-stage/ })).toBeVisible();
  await page.reload();
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("What does the streaming runtime cost");
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(header(page).getByRole("tab", { name: /multi-stage/ })).toHaveCount(0);
  await (await pointAt(page, "Project")).getByRole("menuitem", { name: /^How is the multi-stage design split/ }).click();
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("How is the multi-stage design split?");

  // Delete, from a row's ⋮, asks first and then removes the chat from the library.
  const list = await pointAt(page, "Project");
  const row = list.locator(".conversation-menu-row", { hasText: "Who are the core contributors?" });
  await row.hover();
  await row.getByRole("button", { name: /^Options for Who are the core/ }).click();
  await list.getByRole("menuitem", { name: /^Delete Who are the core/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation" });
  await dialog.getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await catalog(workspace, documentQuery)).map(item => item.id).sort()).toEqual([chats.document[1].id, chats.document[2].id].sort());
  await expect(header(page).getByRole("tab", { name: /core contributors/ })).toHaveCount(0);
  await contextButton(page).click();
  await expect(header(page).getByRole("menuitemradio", { name: /^Project/ })).toHaveAccessibleName(/2 threads/);
  await page.keyboard.press("Escape");

  // A question asked here lands in the chat on screen, and the strip keeps its place.
  const composer = page.locator(".chat-surface").getByRole("textbox");
  await composer.fill("Summarize the split again.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => {
    const history = await (await workspace.request(`/api/chat?${new URLSearchParams({ ...documentQuery, conversation_id: chats.document[1].id })}`)).json();
    return history.messages.filter((message: { role: string }) => message.role === "assistant").length;
  }, { timeout: 30_000 }).toBe(2);
  await expect(header(page).getByRole("tab", { selected: true })).toContainText("How is the multi-stage design split?");

  // Plan is shown in the strip only while it is on; either mode is announced.
  const mode = header(page).getByRole("status"), shown = async () => (await header(page).locator(".composer-mode-label").boundingBox())!.width;
  await expect(mode).toHaveText("Chat");
  expect(await shown()).toBeLessThanOrEqual(1);
  await composer.press("Shift+Tab");
  await expect(mode).toHaveText("Plan");
  expect(await shown()).toBeGreaterThan(20);
  await composer.press("Shift+Tab");
  await expect(mode).toHaveText("Chat");

  // Expand and Hide are buttons of their own.
  await expect(page.locator(".kb-chat-rail.is-fullscreen")).toBeVisible();
  await header(page).getByRole("button", { name: "Collapse chat", exact: true }).click();
  await expect(page.locator(".kb-chat-rail.is-fullscreen")).toHaveCount(0);
  await header(page).getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(page.locator(".chat-surface")).toHaveCount(0);
});

test("a chat still answering shows it on its tab and in its context's list, not only on screen", async ({ page }) => {
  test.setTimeout(120_000);
  const { reader } = await seed(workspace, { document: ["Who are the core contributors?", "How is the multi-stage design split?"], general: [] });
  await page.goto(`${reader}?chat=paper`);
  await (await pointAt(page, "Project")).getByRole("menuitem", { name: /^Who are the core contributors/ }).click();
  workspace.holdChat(true);
  await page.locator(".chat-surface").getByRole("textbox").fill("Keep answering.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  // Expanded, both are tabs: the one left answering says so on its tab.
  await header(page).getByRole("button", { name: "Expand chat", exact: true }).click();
  await header(page).getByRole("tab", { name: /multi-stage/ }).click();
  const answering = header(page).locator(".conversation-tab", { hasText: "Who are the core contributors?" });
  await expect(answering.getByRole("img", { name: "Answering" })).toBeVisible();
  await expect(header(page).locator(".conversation-tab.active .conversation-activity")).toHaveCount(0);
  const row = (await pointAt(page, "Project")).locator(".conversation-menu-row", { hasText: "Who are the core contributors?" });
  // The mark sits after the title, before the time, so titles start in one column.
  const [title, mark, when] = await Promise.all([".conversation-chat-title", ".conversation-activity", ".conversation-chat-when"].map(selector =>
    row.locator(selector).evaluate(node => node.getBoundingClientRect().left)));
  expect(title).toBeLessThan(mark);
  expect(mark).toBeLessThan(when);
  await expect(row.getByRole("img", { name: "Answering" })).toBeVisible();
});

test("beside a Memory page, the map and Health, the divider is drawn in the gap before the chat card", async ({ page }) => {
  for (const path of ["/memory?ask=1", "/memory/graph?ask=1", "/memory/health?ask=1"]) {
    await page.goto(workspace.origin + path);
    const card = page.locator(".kb-chat-rail");
    await expect(card).toBeVisible();
    const divider = page.locator(".kb-rail-split .panel-divider");
    await divider.hover();
    const [line, edge, before] = await divider.evaluate(element => {
      const { left, width } = element.getBoundingClientRect();
      let middle = element.previousElementSibling;
      while (middle && !middle.getBoundingClientRect().width) middle = middle.previousElementSibling;
      return [left + width / 2, document.querySelector(".kb-chat-rail")!.getBoundingClientRect().left, middle!.getBoundingClientRect().right];
    });
    expect(edge - before).toBeGreaterThanOrEqual(16);
    expect(Math.abs(line - (before + edge) / 2)).toBeLessThanOrEqual(1);
  }
});
