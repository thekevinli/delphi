import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * A Memory page an answer names, in the real chat panel, in both scopes.
 *
 * The model writes `[[slug]]` wherever it builds on a page the reader has,
 * beside a document as much as in Memory. The reader should see the page's
 * name as a link in its kind, wherever in the answer it stands, and never the
 * brackets: a name with no page behind it, or with nothing to open it, reads
 * as plain words. Code is the one place the brackets are the text.
 */
const CONVERSATION = "1".repeat(32);
const PAGES = [
  { slug: "kv-cache", title: "KV cache reuse", kind: "concept" },
  { slug: "serving", title: "Serving systems", kind: "domain" },
];
const CITED = { url: "https://example.org/cited", title: "Cited page" };

const ANSWER = [
  "## Builds on [[kv-cache]]",
  "",
  "This rests on [[kv-cache]], filed under [[serving|the serving domain]] (p. 2). It is not [[no-such-page]], nor [[deleted-page|a page that was deleted]].",
  "",
  "- **[[kv-cache]]** in bold, in a list, and ~~[[serving]]~~ struck through.",
  "- Literal syntax stays literal: `[[kv-cache]]`.",
  "",
  "| Page | [[serving]] |",
  "|---|---|",
  "| [[kv-cache]] | a cell |",
  "",
  "```python",
  'link = "[[kv-cache]]"  # the syntax, as text',
  "```",
  "",
  `See [the notes on **[[kv-cache]]**](https://example.org/notes) and ([example.org](${CITED.url})).`,
].join("\n");

const question = { role: "user", content: "What does this build on?", createdAt: "2026-10-12T00:00:00Z", requestId: "r1" };
const answer = { role: "assistant", content: ANSWER, createdAt: "2026-10-12T00:00:05Z", requestId: "r1", sources: [CITED] };

type Stub = { messages?: unknown[]; pages?: (call: number) => unknown; pagesDelayMs?: number; pagesHeld?: Promise<void>; stream?: string; streamHeld?: Promise<void> };

/** The panel's API, answered from fixtures. Returns what the panel asked for. */
async function serve(page: Page, stub: Stub) {
  const seen = { pageReads: 0, sent: [] as Array<Record<string, unknown>> };
  // The shell's answer for a site with no icon.
  await page.route("**/desktop/favicon?**", route => route.fulfill({ status: 204 }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: "What it builds on", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat/stream")) {
      seen.sent.push(request.postDataJSON());
      await stub.streamHeld;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: stub.stream ?? "" });
    }
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages: stub.messages ?? [], images: [] } });
    if (path.endsWith("/api/memory/pages")) {
      seen.pageReads += 1;
      const body = stub.pages ? stub.pages(seen.pageReads) : PAGES;
      if (stub.pagesDelayMs) await new Promise(resolve => setTimeout(resolve, stub.pagesDelayMs));
      await stub.pagesHeld;
      return route.fulfill({ json: body });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}

/** The answer's own text with code taken out: where a bracket would be a defect. */
const prose = (turn: Locator) => turn.evaluate(element => {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("code, pre").forEach(code => code.remove());
  return copy.textContent ?? "";
});

for (const scope of ["document", "general"]) {
  test(`${scope}: a page the answer names is a link in its kind, and no bracket shows`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // React reports a duplicate key or an invalid nesting on the console.
    page.on("console", message => {
      if (message.type() === "error" || /unique "key"|same key|validateDOMNesting|cannot (be|appear as) a (child|descendant)/i.test(message.text())) errors.push(message.text());
    });
    await serve(page, { messages: [question, answer] });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").last();
    await expect(turn).toContainText("in bold, in a list");

    // Every name with a page behind it is a link that reads as the page's
    // title, or as the words the answer chose: in a heading, a paragraph, a
    // list item in bold, struck through, a table's header and a table's cell.
    const links = turn.locator("a.kb-link");
    await expect(links).toHaveText([
      "KV cache reuse", "KV cache reuse", "the serving domain", "KV cache reuse", "Serving systems", "Serving systems", "KV cache reuse",
    ]);
    await expect(turn.locator("h2 a.kb-link")).toHaveCount(1);
    await expect(turn.locator("li strong a.kb-link")).toHaveCount(1);
    await expect(turn.locator("li del a.kb-link")).toHaveCount(1);
    await expect(turn.locator("th a.kb-link")).toHaveCount(1);
    await expect(turn.locator("td a.kb-link")).toHaveCount(1);
    // Each is drawn in its page's kind, with the dot the rail and the map use.
    await expect(turn.locator("a.kb-link.kb-link-concept")).toHaveCount(4);
    await expect(turn.locator("a.kb-link.kb-link-domain")).toHaveCount(3);
    await expect(turn.locator("a.kb-link .kb-link-dot")).toHaveCount(7);
    await expect(links.nth(1)).toHaveAttribute("href", "/memory?page=kv-cache");
    const tint = await links.nth(1).evaluate(element => getComputedStyle(element).backgroundColor);
    expect(tint, "the link carries its kind's tint").not.toBe("rgba(0, 0, 0, 0)");

    // A name with no page is its words: nothing to open, and no bracket.
    await expect(turn).toContainText("It is not no such page, nor a page that was deleted.");
    await expect(turn.getByRole("link", { name: "no such page" })).toHaveCount(0);
    expect(await prose(turn)).not.toMatch(/\[\[|\]\]/);

    // Code is the one place the brackets are the text.
    await expect(turn.locator("li code")).toHaveText("[[kv-cache]]");
    await expect(turn.locator("pre code")).toContainText('link = "[[kv-cache]]"');
    await expect(turn.locator("code a, pre a")).toHaveCount(0);

    // A link the answer wrote cannot hold another: the page's name reads inside it.
    const notes = turn.locator('a[href="https://example.org/notes"]');
    await expect(notes).toHaveText("the notes on KV cache reuse");
    await expect(notes.locator("a")).toHaveCount(0);
    await expect(notes).toHaveAttribute("target", "_blank");
    // What the answer cites from the web is untouched by all this.
    await expect(turn.locator("a.web-citation")).toHaveText(["example.org"]);
    await turn.locator(".answer-sources-toggle").click();
    await expect(turn.locator(".answer-sources a.answer-source .answer-source-title > span")).toHaveText([CITED.title]);
    if (scope === "document") {
      // So is where it cites the document: a page reference is still one.
      await expect(turn.locator(".citation-link")).toHaveText(["p. 2"]);
    }

    // Following a link opens that page and leaves the address alone.
    await links.nth(1).click();
    await expect(page.getByTestId("opened-page")).toHaveText("kv-cache");
    // The app has no tabs, so a modified click opens the page in place too.
    await links.nth(2).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("opened-page")).toHaveText("serving");
    await links.nth(0).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("opened-page")).toHaveText("kv-cache");
    expect(new URL(page.url()).pathname).toBe("/tests/browser/harness.html");
    expect(errors).toEqual([]);
  });
}

for (const scope of ["document", "general"]) {
  test(`${scope}: with nothing to open a page, a name is its words and never a dead link`, async ({ page }) => {
    await serve(page, { messages: [question, answer] });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&no-pages&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").last();
    await expect(turn).toContainText("This rests on KV cache reuse, filed under the serving domain");
    await expect(turn.locator("h2")).toHaveText("Builds on KV cache reuse");
    await expect(turn.locator("a.kb-link")).toHaveCount(0);
    expect(await prose(turn)).not.toMatch(/\[\[|\]\]/);
  });
}

test("before the pages are known a name already reads as words, and becomes a link when they arrive", async ({ page }) => {
  await serve(page, { messages: [question, answer], pagesDelayMs: 1500 });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  const turn = page.locator(".kb-chat-turn").last();
  // The answer is on screen before the page list is: no bracket in the meantime.
  await expect(turn).toContainText("in bold, in a list");
  await expect(turn.locator("a.kb-link")).toHaveCount(0);
  expect(await prose(turn)).not.toMatch(/\[\[|\]\]/);
  await expect(turn.locator("h2")).toHaveText("Builds on kv cache");
  // Then the same names are links, by title.
  await expect(turn.locator("a.kb-link")).toHaveCount(7);
  await expect(turn.locator("h2")).toHaveText("Builds on KV cache reuse");
});

test("an answer as it streams in beside a document names a page filed since the panel opened", async ({ page }) => {
  const events = [
    { type: "delta", text: "This rests on [[kv-" },
    { type: "delta", text: "cache]], filed under [[serving|the serving" },
    { type: "delta", text: " domain]]." },
    { type: "done" },
  ];
  const seen = await serve(page, {
    messages: [],
    // Nothing is filed when the panel opens; the page exists by the time the answer ends.
    pages: call => (call === 1 ? [] : PAGES),
    stream: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  // Until the app session's first answer, the empty composer teaches the side chat.
  await expect(page.locator(".composer-input")).toHaveAttribute("data-placeholder", "Hint: press /side to toggle side chat for quick questions");
  await expect.poll(() => seen.pageReads).toBe(1);
  await page.locator(".composer-input").click();
  await page.keyboard.type("What does this build on?");
  await page.keyboard.press("Enter");

  const turn = page.locator(".kb-chat-turn").last();
  await expect(turn).toContainText("This rests on");
  // The question went out beside the document, not as a Memory chat.
  expect(seen.sent).toHaveLength(1);
  expect(seen.sent[0]).toMatchObject({ scope: "document", prompt: "What does this build on?" });
  // The pages are read again once the answer has ended, so its names are links.
  await expect(turn.locator("a.kb-link")).toHaveText(["KV cache reuse", "the serving domain"]);
  expect(seen.pageReads).toBe(2);
  expect(await prose(turn)).not.toMatch(/\[\[|\]\]/);
  // The answer retires the hint for the rest of the session.
  await expect(page.locator(".composer-input")).toHaveAttribute("data-placeholder", "Ask Delphi anything");
});

/** A request the test lets go of when it says. */
function held() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const followUp = `data: ${JSON.stringify({ type: "delta", text: "It rests on [[kv-cache]]." })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`;

async function askAgain(page: Page) {
  await page.locator(".composer-input").click();
  await page.keyboard.type("And what follows?");
  await page.keyboard.press("Enter");
}

/** Marks an answer's first paragraph, so a test can tell the same node from a remounted one. */
const keep = (turn: Locator) => turn.locator("p").first().evaluate(node => { (node as HTMLElement & { kept?: boolean }).kept = true; });
const kept = (turn: Locator) => turn.locator("p").first().evaluate(node => Boolean((node as HTMLElement & { kept?: boolean }).kept));

for (const scope of ["document", "general"]) {
  test(`${scope}: typing the next question leaves the finished answer mounted`, async ({ page }) => {
    await serve(page, { messages: [question, answer] });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").filter({ hasText: "in bold, in a list" });
    await expect(turn.locator("h2 a.kb-link")).toHaveCount(1);
    await keep(turn);
    await page.locator(".composer-input").click();
    await page.keyboard.type("Next", { delay: 20 });
    expect(await kept(turn)).toBe(true);
  });

  test(`${scope}: an earlier answer stays mounted when the next one ends and the pages are read again`, async ({ page }) => {
    const seen = await serve(page, { messages: [question, answer], stream: followUp });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").filter({ hasText: "in bold, in a list" });
    await expect(turn.locator("h2 a.kb-link")).toHaveCount(1);
    await keep(turn);
    const reread = page.waitForResponse(response => response.url().endsWith("/api/memory/pages"));
    await askAgain(page);
    await reread;
    await expect(page.locator(".kb-chat-turn").last().locator("a.kb-link")).toHaveText(["KV cache reuse"]);
    expect(seen.pageReads).toBe(2);
    // Two frames, so the re-read has been applied before the node is asked about.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // A selection the reader made there would have gone with a remounted node.
    expect(await kept(turn)).toBe(true);
  });

  test(`${scope}: earlier answers keep their Memory links when the chat reopens mid-answer`, async ({ page }) => {
    const stream = held();
    await serve(page, { messages: [question, answer], stream: followUp, streamHeld: stream.promise });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const earlier = page.locator(".kb-chat-turn", { hasText: "in bold, in a list" });
    await expect(earlier.locator("a.kb-link")).toHaveCount(7);
    await askAgain(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.getByRole("button", { name: "Hide chat", exact: true }).click();
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(earlier.locator("a.kb-link")).toHaveCount(7);
    stream.release();
  });

  test(`${scope}: a question sent before the pages arrive still links the earlier answers while it is answered`, async ({ page }) => {
    const pages = held();
    const stream = held();
    await serve(page, { messages: [question, answer], pagesHeld: pages.promise, stream: followUp, streamHeld: stream.promise });
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const earlier = page.locator(".kb-chat-turn", { hasText: "in bold, in a list" });
    await expect(earlier).toBeVisible();
    await askAgain(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    pages.release();
    await expect(earlier.locator("a.kb-link")).toHaveCount(7);
    stream.release();
  });
}

test("struck-through text beside a document may name a page but never cites", async ({ page }) => {
  const struck = { ...answer, content: "Retracted ~~(p. 2)~~, kept (p. 3). Also ~~[[kv-cache]]~~." };
  await serve(page, { messages: [question, struck] });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable&scope=document");
  const turn = page.locator(".kb-chat-turn").filter({ hasText: "Retracted" });
  await expect(turn.locator(".citation-link")).toHaveCount(1);
  await expect(turn.locator("del .citation-link")).toHaveCount(0);
  await expect(turn.locator("del a.kb-link")).toHaveText("KV cache reuse");
});

test("a middle click on a Memory link opens it here, never in a new window", async ({ page, context }) => {
  await serve(page, { messages: [question, answer] });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable&scope=document");
  const link = page.locator(".kb-chat-turn").last().locator("p a.kb-link").first();
  await expect(link).toBeVisible();
  const popups: Page[] = [];
  const opened = (popup: Page) => popups.push(popup);
  context.on("page", opened);
  try {
    await link.click({ button: "middle" });
    await expect(page.getByTestId("opened-page")).toHaveText("kv-cache");
    // Observe the whole click and its aftermath. A popup timeout started
    // before actionability settles can reject before the click even happens.
    await page.waitForTimeout(1500);
    expect(popups).toEqual([]);
  } finally {
    context.off("page", opened);
  }
});
