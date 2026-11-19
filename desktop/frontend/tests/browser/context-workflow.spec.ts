import { expect, test, type Page, type Request } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";

// Which context a question is asked in, as a reader meets it, against the
// installed backend: with a document open every way to ask is that project's
// chat; anywhere else it is Memory's, answered on the Memory chat page, which
// keeps every tool the chat has. Only the model is a fixture.
type Workspace = Awaited<ReturnType<typeof subscriptionWorkspace>>;
type Paper = { id: string; slug: string; title: string };
let workspace: Workspace;
test.use({ actionTimeout: 10_000, viewport: { width: 1512, height: 900 } });
test.beforeEach(async ({ context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
  workspace.answer(ANSWER);
  // Every animation the page starts, so the hand-off's slide can be checked.
  await context.addInitScript(() => {
    const seen: { target: string; duration: unknown }[] = [];
    (window as unknown as { __animations: typeof seen }).__animations = seen;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      seen.push({ target: this.className.toString(), duration: typeof options === "object" ? options.duration : options });
      return animate.call(this, keyframes, options);
    };
  });
});
test.afterEach(async () => { await workspace?.close(); });
const ANSWER = "CONTEXT-ANSWER-17";

/** A project of two documents, as a reader uploads them. */
async function library() {
  const project = await (await workspace.request("/api/projects", { name: "Contracts" })).json() as { id: string; slug: string };
  const upload = async (bytes: Uint8Array, file: string) => {
    const form = new FormData();
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), file);
    const response = await fetch(`${workspace.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: workspace.cookie, origin: workspace.origin }, body: form });
    expect(response.ok).toBe(true);
    return await response.json() as Paper;
  };
  const open = await upload(samplePdf(), "Desktop.pdf");
  // The same page, another line of the same length, so the PDF stays whole.
  const other = await upload(new Uint8Array(Buffer.from(Buffer.from(samplePdf()).toString("latin1").replace("Desktop contract document", "Another contract document"), "latin1")), "Another.pdf");
  return { project, open, other };
}

/** Sends what is in `scope`'s composer and returns the request the page made. */
async function send(page: Page, scope: ReturnType<Page["locator"]>, prompt: string) {
  await scope.getByRole("textbox").fill(prompt);
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === "/api/chat/stream");
  await scope.getByRole("button", { name: "Send", exact: true }).click();
  return (await sent).postDataJSON() as Record<string, unknown>;
}
/** The last round of an answer the model was sent: offered Delphi's own tools, unlike a title or a document's research pass. */
const answering = () => workspace.asked.filter(request => request.tools?.some((tool: { type: string }) => tool.type === "function") && !request.text?.format);
const lastModelInput = () => JSON.stringify(answering().at(-1));
const composer = (page: Page) => page.locator(".kb-composer-card");
const surface = (page: Page) => page.locator(".chat-surface");
const animatedFor = (page: Page, duration: number) =>
  page.evaluate(ms => (window as unknown as { __animations: { target: string; duration: unknown }[] }).__animations.filter(item => item.duration === ms).map(item => item.target), duration);

test("with a document open, Ask Delphi, a passage's Reply and the rail all ask the project's chat", async ({ page }) => {
  test.setTimeout(150_000);
  const { project, open, other } = await library();
  const reader = `${workspace.origin}/@workflow/${project.slug}/${open.slug}`;
  await page.goto(reader);

  // Ask Delphi on the bar opens the composer, which offers no other context.
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).not.toContainText("Memory");
  await expect(page.getByRole("button", { name: /context/i })).toHaveCount(0);
  const asked = await send(page, composer(page), "What is the proper reading order in this project?");
  expect(asked).toMatchObject({ scope: "document", project_id: project.id, paper_id: open.id, desktop_mode: "chat" });
  // The question docks the project's chat beside the document, and is answered with the whole project behind it.
  await expect(page).toHaveURL(/[?&]chat=paper/);
  await expect(surface(page).locator(".message.assistant")).toContainText(ANSWER, { timeout: 30_000 });
  expect(lastModelInput()).toContain(other.title);
  // One title, no tabs and no Memory anywhere in the rail.
  await expect(surface(page).locator(".conversation-switch-trigger")).toBeVisible();
  await expect(surface(page).getByRole("tab")).toHaveCount(0);
  await expect(surface(page).locator(".conversation-header")).not.toContainText("Memory");

  // A follow-up in the rail stays in the same chat and context.
  const conversation = asked.conversation_id;
  const followUp = await send(page, surface(page).locator(".composer"), "And which comes first?");
  expect(followUp).toMatchObject({ scope: "document", paper_id: open.id, conversation_id: conversation });
  await expect(surface(page).locator(".message.assistant").nth(1)).toContainText(ANSWER, { timeout: 30_000 });

  // With the chat docked, Ask Delphi answers by nudging it, not with a second composer.
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  await expect(composer(page)).toHaveCount(0);

  // With it hidden, a passage's Reply opens the composer quoting it, and asks the same project.
  await page.getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(surface(page)).toHaveCount(0);
  const line = page.locator(".pdf-page .text-layer span", { hasText: "Desktop contract document" }).first();
  await line.waitFor({ timeout: 30_000 });
  // The page widens and redraws as the chat leaves: select once it has come to rest.
  let box = await line.boundingBox();
  await expect.poll(async () => {
    const now = await line.boundingBox().catch(() => null);
    const still = Boolean(now && box && Math.abs(now.x - box.x) < 0.5 && Math.abs(now.width - box.width) < 0.5);
    box = now;
    return still;
  }, { intervals: [300] }).toBe(true);
  if (!box) throw new Error("the line has no box");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator(".selection-menu").getByRole("button", { name: "Reply", exact: true }).click();
  await expect(composer(page)).toContainText("Desktop contract");
  const replied = await send(page, composer(page), "What does this line claim?");
  expect(replied).toMatchObject({ scope: "document", project_id: project.id, paper_id: open.id });
  expect(String(replied.selected_text)).toContain("Desktop contract");
  await expect(surface(page).locator(".message.user").last()).toContainText("What does this line claim?");
  await expect(surface(page).locator(".message.assistant").last()).toContainText(ANSWER, { timeout: 30_000 });
});

test("without a document open, Ask Delphi asks Memory and slides into the Memory chat page", async ({ page }) => {
  test.setTimeout(150_000);
  await library();
  const empty = await (await workspace.request("/api/projects", { name: "Unread" })).json() as { slug: string };
  const memoryChats = async () => ((await (await workspace.request("/api/chat/conversations?scope=general")).json()).items as { id: string; empty?: boolean }[]).filter(item => !item.empty);

  // A project with no document to open: Memory.
  await page.goto(`${workspace.origin}/@workflow/${empty.slug}`);
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  const fromProject = await send(page, composer(page), "Which of my documents are about contracts?");
  expect(fromProject).toMatchObject({ scope: "general" });
  for (const key of ["project_id", "paper_id", "selected_text", "viewport"]) expect(fromProject[key] ?? null).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/memory/chat\\?conversation=${fromProject.conversation_id}`));
  await expect(page.locator(".kb-memory-chat .message.assistant")).toContainText(ANSWER, { timeout: 30_000 });
  // The composer that sent it came down into the page's own over 420ms, and the conversation faded in.
  expect(await animatedFor(page, 420)).toEqual(expect.arrayContaining([expect.stringContaining("composer"), expect.stringContaining("messages")]));

  // The map's Ask does the same, into a chat of its own.
  await page.goto(`${workspace.origin}/memory/graph`);
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  const fromMap = await send(page, composer(page), "What connects my reading?");
  expect(fromMap).toMatchObject({ scope: "general" });
  expect(fromMap.conversation_id).not.toBe(fromProject.conversation_id);
  await expect(page).toHaveURL(new RegExp(`/memory/chat\\?conversation=${fromMap.conversation_id}`));
  await expect(page.locator(".kb-memory-chat .message.assistant")).toContainText(ANSWER, { timeout: 30_000 });
  await expect.poll(async () => (await memoryChats()).length).toBe(2);
  // Both are listed, the newest open; Back returns to the map.
  const list = page.getByRole("navigation", { name: "Memory chats" });
  await expect(list.locator(".conversation-row.is-current")).toHaveAttribute("data-conversation", String(fromMap.conversation_id));
  await expect(list.locator(`[data-conversation="${fromProject.conversation_id}"]`)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/memory\/graph/);
});

test("the Memory chat page from the Dashboard keeps persona, the side chat and every chat tool, and offers no Plan mode", async ({ page }) => {
  test.setTimeout(150_000);
  await library();
  const persona = await (await workspace.request("/api/personas", { name: "Terse tutor", content: "Answer in one sentence. PERSONA-MARK-91" })).json() as { id: string };

  await page.goto(workspace.origin);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.locator(".dashboard-sidebar").getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(`${workspace.origin}/memory/chat`);
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  const chat = page.locator(".kb-memory-chat");

  // The persona picked in its composer answers.
  await chat.getByRole("button", { name: "Answer persona", exact: true }).click();
  await page.getByRole("listbox", { name: "Choose answer persona" }).getByRole("option", { name: /Terse tutor/ }).click();
  const asked = await send(page, chat.locator(".composer"), "What have I read about contracts?");
  expect(asked).toMatchObject({ scope: "general", persona_id: persona.id });
  await expect(chat.locator(".message.assistant")).toContainText(ANSWER, { timeout: 30_000 });
  expect(lastModelInput()).toContain("PERSONA-MARK-91");
  // The account-wide chat's whole ladder is offered: Memory, every document, the web. (The inline
  // visuals join it where a renderer is installed, as in the app; this rig has none.)
  const tools = (answering().at(-1).tools as { name?: string; type: string }[]).map(tool => tool.name ?? tool.type);
  expect(tools.sort()).toEqual(["grep_memory", "memory_links", "open_memory", "read_paper", "read_url", "read_webpage", "search_library", "view_figure", "web_search"]);

  // No Plan mode: a plan's sources are captured from a document, and Memory chat has none open.
  await chat.locator(".composer").getByRole("textbox").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(chat.locator(".composer-mode-tag")).toHaveCount(0);
  expect((await workspace.request("/api/chat/stream", {
    desktop_mode: "plan", prompt: "Plan a check of what I read.", scope: "general", conversation_id: asked.conversation_id,
  })).status).toBe(400);
  expect(lastModelInput()).not.toContain("Shift+Tab");

  // The side chat opens beside it and stores nothing.
  const before = (await (await workspace.request(`/api/chat?scope=general&conversation_id=${asked.conversation_id}&generation=0`)).json()).messages.length;
  await chat.locator(".composer").getByRole("textbox").click();
  await page.keyboard.type("/side");
  await page.keyboard.press("Enter");
  const side = page.getByRole("complementary", { name: "Side chat" });
  await side.getByRole("textbox", { name: "Side question", exact: true }).fill("What is a contract?");
  await page.keyboard.press("Enter");
  await expect(side.locator(".side-chat-answer")).toContainText(ANSWER, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect((await (await workspace.request(`/api/chat?scope=general&conversation_id=${asked.conversation_id}&generation=0`)).json()).messages.length).toBe(before);

  // Map and back: the chat waits in the list and reopens whole.
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await expect(page).toHaveURL(/\/memory\/graph/);
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const list = page.getByRole("navigation", { name: "Memory chats" });
  await list.locator(`[data-conversation="${asked.conversation_id}"] > button`).first().click();
  await expect(chat.locator(".message.user").first()).toContainText("What have I read about contracts?");
  await expect(chat.locator(".message.assistant")).toHaveCount(1);
});

test("a document chat's citation of a document in another project opens it there, and Back returns", async ({ page }) => {
  test.setTimeout(120_000);
  const { project, open } = await library();
  const elsewhere = await (await workspace.request("/api/projects", { name: "Elsewhere" })).json() as { id: string; slug: string };
  const form = new FormData();
  form.append("file", new Blob([samplePdf(3)], { type: "application/pdf" }), "Abroad.pdf");
  const response = await fetch(`${workspace.origin}/api/projects/${elsewhere.id}/papers`, { method: "POST", headers: { cookie: workspace.cookie, origin: workspace.origin }, body: form });
  expect(response.ok).toBe(true);
  const abroad = await response.json() as Paper;
  workspace.answer(`The other project says so (${abroad.title}, p. 3).`);

  const reader = `${workspace.origin}/@workflow/${project.slug}/${open.slug}?chat=paper`;
  await page.goto(reader);
  await send(page, surface(page).locator(".composer"), "What does the other project say?");
  // The chip names the document the library holds, though this project does not.
  const citation = surface(page).locator(".message.assistant .citation-link.is-aside");
  await expect(citation).toHaveText(`${abroad.title} · p. 3`, { timeout: 30_000 });
  await citation.click();
  await expect(page).toHaveURL(new RegExp(`/@workflow/${elsewhere.slug}/${abroad.slug}(?:[?#]|$)`));
  // At the page cited, which survives the move into the other project.
  await expect(page.locator('.pdf-page[data-page="3"]')).toBeInViewport({ timeout: 30_000 });
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/@workflow/${project.slug}/${open.slug}`));
  await expect(surface(page).locator(".message.user")).toContainText("What does the other project say?");
});
