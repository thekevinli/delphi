import { test, expect, type Page } from "@playwright/test";

/**
 * What a stored answer shows of the web and of how it ended, in the real chat
 * panel, in both scopes: no control to switch search on, cited pages as chips
 * with a list under the answer, and a cut-off answer that says so and can be
 * asked for again.
 */
const PAPER = { url: "https://arxiv.org/abs/2203.03466", title: "Tensor Programs V" };
const CODE = { url: "https://github.com/microsoft/mup", title: "microsoft/mup" };
const CONVERSATION = "1".repeat(32);

async function stored(page: Page, messages: unknown[]) {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: "Follow-up work", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { messages, images: [] } });
    return route.fulfill({ json: { items: [] } });
  });
}

/** Sources are computed at idle, then painted. Wait through layout as well so
 * the scroll observer has seen the settled height before simulating a reader. */
const settled = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise<void>(done => {
    const painted = () => requestAnimationFrame(() => requestAnimationFrame(() => done()));
    if (typeof requestIdleCallback === "function") requestIdleCallback(painted, { timeout: 2000 });
    else painted();
  });
});

const question = { role: "user", content: "What came after this work?", createdAt: "2026-10-11T00:00:00Z", requestId: "r1" };

for (const scope of ["document", "general"]) {
  test(`${scope}: a stored answer shows its cited pages, and there is no Web control`, async ({ page }) => {
    await stored(page, [question, {
      role: "assistant", createdAt: "2026-10-11T00:00:05Z", requestId: "r1",
      content: `The follow-up work is public ([arxiv.org](${PAPER.url})), and so is its code ([github.com](${CODE.url})). See also [a note](https://example.org/note).`,
      sources: [PAPER, CODE],
    }]);
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").last();
    await expect(turn).toContainText("The follow-up work is public");
    await expect(page.getByRole("button", { name: /Web Search/i })).toHaveCount(0);
    // A cited link is a chip that says its site and leaves the app.
    const chips = turn.locator("a.web-citation");
    await expect(chips).toHaveText(["arxiv.org", "github.com"]);
    await expect(chips.first()).toHaveAttribute("href", PAPER.url);
    await expect(chips.first()).toHaveAttribute("target", "_blank");
    // A link the answer did not cite stays an ordinary one, and still leaves the app.
    const note = turn.getByRole("link", { name: "a note" });
    await expect(note).not.toHaveClass(/web-citation/);
    await expect(note).toHaveAttribute("target", "_blank");
    // The answer lists what it rests on, once each, folded until asked.
    const fold = turn.locator(".answer-sources-toggle");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toContainText("2 pages · arxiv.org, github.com");
    await fold.click();
    await expect(turn.locator(".answer-sources a.answer-source .answer-source-title > span")).toHaveText([PAPER.title, CODE.title]);
  });
}

for (const scope of ["document", "general"]) {
  test(`${scope}: a citation written out as code or mathematics reads exactly as the answer wrote it`, async ({ page }) => {
    const quoted = `([arxiv.org](${PAPER.url}))`;
    await stored(page, [question, {
      role: "assistant", createdAt: "2026-10-11T00:00:05Z", requestId: "r1",
      content: `The follow-up work is public ${quoted}. Cite it as \`${quoted}\`, or in a block:\n\n\`\`\`md\nSee ${quoted}.\n\`\`\`\n\nAs a set, $f${quoted}$.`,
      sources: [PAPER],
    }]);
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").last();
    await expect(turn.locator("a.web-citation")).toHaveText(["arxiv.org"]);
    await expect(turn.locator("p").first()).toContainText("The follow-up work is public arxiv.org.");
    await expect(turn.locator("p code")).toHaveText(quoted);
    await expect(turn.locator("pre code")).toHaveText(`See ${quoted}.`);
    await expect(turn.locator(".katex annotation")).toHaveText(`f${quoted}`);
  });
}

test("a cut-off answer says so and offers to ask again", async ({ page }) => {
  await stored(page, [question, {
    role: "assistant", createdAt: "2026-10-11T00:00:05Z", requestId: "r1",
    content: "The follow-up work is", incomplete: { reason: "max_output_tokens" },
  }]);
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  const notice = page.locator(".message-cutoff");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await settled(page);
  await expect(page.locator(".answer-sources")).toHaveCount(0);
});

const REPO = { url: "https://github.com/sgl-project/sglang-omni", title: "GitHub - sgl-project/sglang-omni: SGLang-Omni is a serving framework for omni models · GitHub" };
const DOCS = { url: "https://docs.vllm.ai/en/latest/features/disagg_prefill.html", title: "Disaggregated Prefilling - vLLM" };
const MEMORY = { slug: "kv-cache", title: "KV cache reuse", kind: "concept", summary: "Reusing attention state across requests." };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const RESTS_ON = [
  "## **Results (p. 4)**",
  "",
  "Prefill and decode can run apart [[kv-cache]] (p. 2).",
  "",
  `The omni server does this ([github.com](${REPO.url})), following vLLM ([docs.vllm.ai](${DOCS.url})).`,
  "",
  `Its router is separate too ([github.com](${REPO.url})).`,
].join("\n");

/** The panel's API and the shell's icon route, with github.com the one site that has an icon. */
async function restsOn(page: Page, messages: unknown[]) {
  await stored(page, messages);
  await page.route("**/api/memory/pages", route => route.fulfill({ json: [MEMORY] }));
  const icons: string[] = [];
  await page.route("**/desktop/favicon?**", route => {
    const host = new URL(route.request().url()).searchParams.get("host")!;
    icons.push(host);
    return host === "github.com"
      ? route.fulfill({ contentType: "image/png", body: PNG })
      : route.fulfill({ status: 204, headers: { "cache-control": "no-store" } });
  });
  // The reader itself never loads anything from a site an answer cites.
  const outside: string[] = [];
  page.on("request", request => { if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(request.url()) && !request.url().startsWith("data:")) outside.push(request.url()); });
  return { icons, outside };
}

for (const scope of ["document", "general"]) {
  test(`${scope}: a reader checks what an answer rests on, then leaves for one page and opens another in place`, async ({ page }) => {
    const seen = await restsOn(page, [question, { role: "assistant", createdAt: "2026-10-11T00:00:05Z", requestId: "r1", content: RESTS_ON, sources: [REPO, DOCS] }]);
    await page.goto(`/tests/browser/harness.html?responsive-chat&closable&scope=${scope}`);
    const turn = page.locator(".kb-chat-turn").last();
    await expect(turn).toContainText("The omni server does this");

    // A heading names things, bold or not: it never cites.
    await expect(turn.locator("h2")).toHaveText("Results (p. 4)");
    await expect(turn.locator("h2 .citation-link")).toHaveCount(0);
    // A citation reads as a chip with no parentheses around it.
    const chips = turn.locator("a.web-citation");
    await expect(chips).toHaveText(["github.com", "docs.vllm.ai", "github.com"]);
    await expect(turn).not.toContainText("(github.com");
    await expect(turn).toContainText("following vLLM docs.vllm.ai.");
    // A site with an icon shows it; one without keeps its letter.
    await expect(chips.first().locator(".site-mark")).toHaveClass(/has-icon/);
    await expect(chips.nth(1).locator(".site-mark")).not.toHaveClass(/has-icon/);
    await expect(chips.nth(1).locator(".site-mark")).toHaveAttribute("data-letter", "V");

    // Resting on a chip says which page it is before leaving for it.
    await chips.first().hover();
    const peek = page.getByRole("tooltip");
    await expect(peek).toContainText("sgl-project/sglang-omni");
    await expect(peek).toContainText("SGLang-Omni is a serving framework for omni models");
    await expect(peek).toContainText("Opens in your browser");
    await expect(peek).not.toContainText("· GitHub");
    await expect(chips.first()).toHaveAttribute("aria-describedby", await peek.getAttribute("id") ?? "");
    await turn.locator("p").first().hover();
    await expect(peek).toHaveCount(0);

    // Folded, the list is one line under the answer.
    const fold = turn.locator(".answer-sources-toggle");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toContainText(scope === "document" ? "1 Memory page · 1 passage · 2 web pages" : "1 Memory page · 2 web pages");
    await expect(turn.locator(".answer-source")).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");

    // Its corners are the composer's.
    await expect(turn.locator(".answer-sources-list")).toHaveCSS("border-radius", await page.locator(".composer").evaluate(element => getComputedStyle(element).borderRadius));
    // Open, it is one collection: Memory first, then what it cites, each kind labelled.
    const sections = turn.locator(".answer-sources-section");
    await expect(sections).toHaveText(scope === "document" ? ["Memory", "Documents", "Web sources"] : ["Memory", "Web sources"]);
    const titles = turn.locator(".answer-source-title > span");
    await expect(titles).toHaveText(scope === "document"
      ? ["KV cache reuse", "Page 2", "sgl-project/sglang-omni", "Disaggregated Prefilling"]
      : ["KV cache reuse", "sgl-project/sglang-omni", "Disaggregated Prefilling"]);
    await expect(turn.locator(".answer-source-detail").first()).toHaveText(MEMORY.summary);
    if (scope === "document") await expect(turn.locator(".answer-source-detail").nth(1)).toHaveText("SGLang (2312.07104v2)");
    // A page cited twice says so, beside its title.
    const repo = turn.locator("a.answer-source", { hasText: "sgl-project/sglang-omni" });
    await expect(repo.locator(".answer-source-title small")).toHaveText("2×");
    await expect(repo.locator(".answer-source-title small")).toHaveAttribute("title", "Cited 2 times in this answer");
    await expect(repo.locator(".answer-source-detail")).toHaveText("github.com · SGLang-Omni is a serving framework for omni models");
    await expect(turn.locator("a.answer-source", { hasText: "Disaggregated" }).locator(".answer-source-detail"))
      .toHaveText("docs.vllm.ai · en/latest/features/disagg_prefill.html");
    await expect(turn.locator(".answer-source-title small")).toHaveCount(1);

    // A web page leaves the app; a Memory page opens in place.
    await expect(repo).toHaveAttribute("href", REPO.url);
    await expect(repo).toHaveAttribute("target", "_blank");
    await expect(repo).toHaveAttribute("rel", "noopener noreferrer");
    await turn.getByRole("button", { name: /KV cache reuse/ }).click();
    await expect(page.getByTestId("opened-page")).toHaveText("kv-cache");
    expect(new URL(page.url()).pathname).toBe("/tests/browser/harness.html");

    // Icons come from the shell, and nothing from the sites themselves.
    // A site with no icon is asked once however many marks show it; one with an
    // icon is drawn from the image the first ask loaded.
    expect([...new Set(seen.icons)].sort()).toEqual(["docs.vllm.ai", "github.com"]);
    expect(seen.icons.filter(host => host === "docs.vllm.ai")).toHaveLength(1);
    expect(seen.outside).toEqual([]);

    // Folding it again leaves the one line.
    await fold.click();
    await expect(turn.locator(".answer-source")).toHaveCount(0);
  });
}

test("a long passage the reader asked about shows three lines and opens on request, and an expired image says so", async ({ page }) => {
  const passage = Array.from({ length: 12 }, (_, n) => `Sentence ${n + 1} of the passage the reader selected in the document.`).join(" ");
  await stored(page, [
    { ...question, selectedText: passage, referencedImages: [{ id: "gone", number: 1 }] },
    { role: "assistant", createdAt: "2026-10-11T00:00:05Z", requestId: "r1", content: "It is about routing." },
    { role: "user", content: "And this?", createdAt: "2026-10-11T00:01:00Z", requestId: "r2", selectedText: "A short one." },
  ]);
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  const [long, short] = [page.locator(".message.user blockquote").first(), page.locator(".message.user blockquote").last()];
  await expect(long).toContainText("Sentence 1 of");
  const lines = async () => long.evaluate(node => Math.round(node.clientHeight / parseFloat(getComputedStyle(node).lineHeight)));
  expect(await lines()).toBeLessThanOrEqual(4);
  const toggle = page.getByRole("button", { name: "Show all" });
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  expect(await lines()).toBeGreaterThan(4);
  await expect(long).toHaveJSProperty("scrollHeight", await long.evaluate(node => node.clientHeight));
  // A passage that fits has nothing to open.
  await expect(short).toHaveText("A short one.");
  await page.getByRole("button", { name: "Show less" }).click();
  expect(await lines()).toBeLessThanOrEqual(4);

  const expired = page.getByRole("img", { name: "Image #1 · Image expired" });
  await expect(expired).toBeVisible();
  await expect(expired).toHaveText("#1");
});

test("a long chat opens at its newest answer, with every Sources line in place", async ({ page }) => {
  const turns = Array.from({ length: 12 }, (_, n) => [
    { role: "user", content: `Question ${n}`, createdAt: "2026-10-11T00:00:00Z", requestId: `r${n}` },
    { role: "assistant", content: `Answer ${n} cites [[kv-cache]] and code ([github.com](${REPO.url})).`, createdAt: "2026-10-11T00:00:05Z", requestId: `r${n}`, sources: [REPO, DOCS] },
  ]).flat();
  await restsOn(page, turns);
  await page.goto("/tests/browser/harness.html?responsive-chat&closable");
  await expect(page.locator(".answer-sources-toggle")).toHaveCount(12);
  await settled(page);
  const transcript = page.locator(".messages");
  await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  await expect(page.locator(".answer-sources-toggle").last()).toBeInViewport();

  // A reader who scrolled up to read is left there.
  // Focus before scrolling: WebKit may scroll a newly focused button into
  // view. This assertion measures expansion, not the browser’s focus placement.
  const firstSource = page.locator(".answer-sources-toggle").first();
  await firstSource.focus();
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await settled(page);
  await firstSource.press("Enter");
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(0);
});
