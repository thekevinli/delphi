import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Every mark an answer can carry, in the real chat panel, as a reader sees it:
 * a citation set apart from the sentence is a quiet chip naming the place (and
 * the document, when it is not the one on screen); a place the sentence names
 * stays a word of it; a Memory page is a neutral pill with its kind's square;
 * and only a lead-in is drawn bold.
 */
const CONVERSATION = "3".repeat(32);
const OPEN = "Small-Scale Experiments";
const OTHER = "Scaling Laws for Neural Language Models";
const SITE = { url: "https://example.org/reports/scaling", title: "An outside report" };
/** A web page the library holds: a link to it opens the library's copy. */
const KEPT = { url: "https://lilianweng.github.io/posts/2025-05-01-thinking/", title: "Why We Think" };

const ANSWER = [
  "**Lead with the answer.** Error rises from **7.9% at 4M to 28.1% at 134M** as runs grow (Small-Scale Experiments, pp. 4–5).",
  "",
  "The trend holds at scale (Scaling Laws for Neural Language Models, Fig. 4, p. 11), and both agree (Small-Scale Experiments, p. 4; Scaling Laws for Neural Language Models, p. 7).",
  "",
  "**Table 6, p. 11** reports it, and Fig. 3 (p. 4) shows why. This refines [[hp-transfer]].",
  "",
  `A survey reports the same ([lilianweng.github.io](${KEPT.url})), as does a report ([example.org](${SITE.url})).`,
  "",
  "Seven runs agree (n = 7; Table 3, p. 7), as does `Table 2, p. 3`, and twice over (Small-Scale Experiments, p. 2)(Scaling Laws, p. 3). Kaplan disagrees (Kaplan et al., p. 5).",
  "",
  "Its table agrees (Scaling Laws, p. 7; Table 2, p. 9).",
  "",
  "In the other order (Scaling Laws, p. 8; Small-Scale Experiments, p. 9).",
  "",
  "- **Bias** — it compounds.",
].join("\n");

async function show(page: Page, memory: boolean) {
  const papers = [
    ...[OPEN, OTHER].map((title, index) => ({ id: `p${index}`, slug: `p${index}`, title, filename: `p${index}.pdf`, pages: 30, tokens: 0 })),
    { id: "w", slug: "w", title: KEPT.title, url: KEPT.url, type: "web", tokens: 0 },
  ];
  await page.route("**/desktop/favicon?**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/test/case") return route.fulfill({ json: { memory, papers, current: memory ? null : OPEN } });
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: "Marks", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { images: [], messages: [
      { role: "user", content: "How does error scale?", createdAt: "2026-11-16T00:00:00Z", requestId: "r1" },
      { role: "assistant", content: ANSWER, sources: [SITE], createdAt: "2026-11-16T00:00:05Z", requestId: "r1" },
    ] } });
    if (path.endsWith("/api/memory/pages")) return route.fulfill({ json: [{
      id: "hp-transfer", slug: "hp-transfer", domain: "scaling", kind: "concept", title: "Hyperparameter transfer", summary: "Tuning small, transferring large.",
      tags: [], revision: 1, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z", linkDegree: 1,
    }] });
    if (path === "/api/dashboard") return route.fulfill({ json: { stats: {}, conversations: [], projects: [
      { id: "project", name: "Project", slug: "project", accentIndex: 0, totalCount: papers.length, activeCount: papers.length, lastEngagedAt: "",
        documents: papers.map((paper) => ({ ...paper, projectId: "project", projectName: "Project", projectSlug: "project" })) },
    ] } });
    if (path.endsWith("/anchors")) return route.fulfill({ json: { papers: {} } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?answers");
  const body = page.locator(".message.assistant").last();
  await expect(body.locator(".citation-link.is-aside").first()).toBeVisible();
  return body;
}

const style = (locator: Locator, property: string) => locator.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);
/** The chat card at `width` pixels, as a narrow or zoomed column has it; null puts it back. */
const narrow = (body: Locator, width: number | null) => body.page().locator(".chat-surface").evaluate((card: HTMLElement, to) => {
  card.style.flex = to === null ? "" : "none";
  card.style.width = to === null ? "" : `${to}px`;
}, width);
/** What a reader sees of an element's text: without the marks kept only for copying. */
const seen = (locator: Locator) => locator.evaluate((node) => {
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll(".visually-hidden").forEach((mark) => mark.remove());
  return copy.textContent;
});
/** What copying an element's whole text puts on the clipboard. */
const copied = (locator: Locator) => locator.evaluate((node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  selection.removeAllRanges();
  return text;
});

test("beside a document: chips say what was written, naming another document the library holds", async ({ page }) => {
  const body = await show(page, false);
  const chips = body.locator(".citation-link.is-aside");
  await expect(chips).toHaveText([
    "pp. 4–5",
    `${OTHER} · Fig. 4, p. 11`,
    "p. 4",
    `${OTHER} · p. 7`,
    // A link to a web page the library holds is a chip in the model's words, led by its title.
    `${KEPT.title} · lilianweng.github.io`,
    "Table 3, p. 7",
    "Table 2, p. 3",
    "p. 2",
    `${OTHER} · p. 3`,
    // A name the library cannot place is the model's words, beside the open document it falls to.
    "Kaplan et al., p. 5",
    // A parenthetical names its document once.
    `${OTHER} · p. 7`,
    "Table 2, p. 9",
    // After another document's chip, the open one is named, so its page cannot read as the other's.
    `${OTHER} · p. 8`,
    `${OPEN} · p. 9`,
  ]);
  // Its visible words are its name; a long title is clipped by style, whole in the text and the tooltip.
  const other = chips.nth(1);
  await expect(other).toHaveAccessibleName(`${OTHER} · Fig. 4, p. 11`);
  await expect(other).toHaveAttribute("title", OTHER);
  expect(await other.locator("b").evaluate((title) => title.scrollWidth > title.clientWidth)).toBe(true);
  expect(await style(other, "white-space")).toBe("nowrap");
  // Clipped, the title leaves the chip no wider than what it shows.
  expect(await other.evaluate((chip) => chip.getBoundingClientRect().right - chip.querySelector(".citation-words")!.getBoundingClientRect().right)).toBeLessThanOrEqual(await other.evaluate((chip) => parseFloat(getComputedStyle(chip).paddingRight) + 1));
  // In a narrow column the title gives way first, to half the turn, and the place stays whole on its line.
  const inside = (chip: Locator) => chip.evaluate((node) => node.getBoundingClientRect().right <= node.closest("p")!.getBoundingClientRect().right + 1);
  // Every line of the words lies inside the chip.
  const whole = (chip: Locator) => chip.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return [...node.querySelector(".citation-words")!.getClientRects()].every((line) => line.left >= box.left - 0.5 && line.right <= box.right + 0.5);
  });
  const lines = (chip: Locator) => chip.locator(".citation-words").evaluate((words) => words.getClientRects().length);
  await narrow(body, 260);
  const place = chips.nth(1);
  expect(await place.locator("b").evaluate((title) => title.getBoundingClientRect().width)).toBeLessThanOrEqual(131);
  expect(await whole(place)).toBe(true);
  expect(await inside(place)).toBe(true);
  expect(await lines(place)).toBe(1);
  // Narrower still, as a zoomed side chat is, the words wrap rather than lose any of what the model wrote, and the answer never scrolls sideways.
  await narrow(body, 110);
  expect(await whole(place)).toBe(true);
  expect(await inside(place)).toBe(true);
  expect(await lines(place)).toBeGreaterThan(1);
  expect(await body.locator("p").nth(1).evaluate((paragraph) => paragraph.scrollWidth <= paragraph.clientWidth)).toBe(true);
  // At the reader's chat zoom the turn grows and the card does not: the title still keeps inside its column.
  await narrow(body, 320);
  await page.locator(".chat-surface").evaluate((card: HTMLElement) => card.style.setProperty("--chat-zoom", "2"));
  expect(await whole(place)).toBe(true);
  expect(await inside(place)).toBe(true);
  expect(await body.locator("p").nth(1).evaluate((paragraph) => paragraph.scrollWidth <= paragraph.clientWidth)).toBe(true);
  await page.locator(".chat-surface").evaluate((card: HTMLElement) => card.style.removeProperty("--chat-zoom"));
  await narrow(body, null);
  // A parenthetical with other words keeps its brackets and its words; adjacent ones lose theirs.
  const last = body.locator("p").nth(4);
  await expect(last).toContainText("(n = 7; Table 3, p. 7)");
  expect(await seen(last)).toContain(`twice over p. 2 ${OTHER} · p. 3. Kaplan`);
  // A citation quoted as code is a chip too, and a chip follows from the keyboard.
  await expect(last.locator("code")).toHaveCount(0);
  await chips.nth(6).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("opened")).toHaveText(/^Small-Scale Experiments \| Table 2, p. 3 \| /);
  // A parenthetical of nothing but citations loses its brackets to the eye; the sentence keeps its full stop.
  const paragraph = body.locator("p").nth(1);
  expect(await seen(paragraph)).not.toContain("(");
  expect(await seen(paragraph)).toContain("p. 7.");
  // Copied, or quoted in a Reply, it reads as the model wrote it: brackets, semicolons, every place's document.
  expect(await copied(paragraph)).toBe(`The trend holds at scale (${OTHER} · Fig. 4, p. 11), and both agree (p. 4; ${OTHER} · p. 7).`);
  expect(await copied(last)).toContain(`twice over (p. 2) (${OTHER} · p. 3). Kaplan disagrees (Kaplan et al., p. 5).`);
  // A place the sentence names is a word of it: its type, its colour, a dotted underline.
  const inline = body.locator(".citation-link:not(.is-aside)");
  await expect(inline).toHaveText(["Table 6, p. 11", "Fig. 3 (p. 4)"]);
  const sentence = body.locator("p").nth(2);
  for (const property of ["color", "font-size", "font-weight", "font-family"]) {
    expect(await style(inline.last(), property)).toBe(await style(sentence, property));
  }
  expect(await style(inline.last(), "text-decoration-style")).toBe("dotted");
  // A cited site is the same quiet chip.
  const site = body.locator("a.web-citation");
  expect(await style(site, "background-color")).toBe(await style(other, "background-color"));
});

test("in Memory: with no document on screen, every chip names a document the library holds", async ({ page }) => {
  const body = await show(page, true);
  await expect(body.locator(".citation-link.is-aside").first()).toHaveText(`${OPEN} · pp. 4–5`);
  // A name the library cannot place is never shown as a document: the chip is its words.
  expect(await seen(body.locator("p").nth(4))).toContain("Kaplan disagrees Kaplan et al., p. 5.");
  await expect(body.locator("strong.lead")).toHaveText(["Lead with the answer.", "Bias"]);
  expect(await style(body.locator("a.kb-link"), "background-color")).toBe("rgb(244, 241, 239)");
});

test("only a lead-in is bold, and a Memory page is a neutral pill in its kind", async ({ page }) => {
  const body = await show(page, false);
  const lead = body.locator("strong.lead");
  await expect(lead).toHaveText(["Lead with the answer.", "Bias"]);
  expect(Number(await style(lead.first(), "font-weight"))).toBe(600);
  const sentence = body.locator("p").first();
  for (const run of await body.locator("strong:not(.lead)").all()) {
    expect(await style(run, "font-weight")).toBe(await style(sentence, "font-weight"));
    expect(await style(run, "color")).toBe(await style(sentence, "color"));
  }
  expect(await body.locator("li").first().evaluate((item) => getComputedStyle(item, "::marker").color)).toBe("rgb(154, 133, 129)");
  await expect(body.locator("li strong.lead")).toHaveText(["Bias"]);
  const memory = body.locator("a.kb-link");
  await expect(memory).toHaveText("Hyperparameter transfer");
  await expect(memory.locator(".kb-link-dot")).toBeVisible();
  const site = await style(body.locator("a.web-citation"), "background-color");
  expect(await style(memory, "background-color")).toBe(site);
  // Approached, it takes its kind's tint.
  await memory.hover();
  await expect.poll(() => style(memory, "background-color")).not.toBe(site);
});

const sse = (...events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

/** The responsive chat card, with a stored answer and a side chat that answers `side`. */
async function card(page: Page, answer: string, side = "") {
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chat/side")) return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse({ type: "delta", text: side }, { type: "done", trace: null, sources: [] }) });
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: "Marks", empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { images: [], messages: [
      { role: "user", content: "How does error scale?", createdAt: "2026-11-16T00:00:00Z", requestId: "r1" },
      { role: "assistant", content: answer, createdAt: "2026-11-16T00:00:05Z", requestId: "r1" },
    ] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/tests/browser/harness.html?responsive-chat&closable&width=820");
  await expect(page.locator(".chat-surface .messages .message.assistant")).toBeVisible();
}

test("a side chat's answer draws only its lead-in bold, as the main chat's does", async ({ page }) => {
  await card(page, "Main answer.", "**Short answer.** It rises **sharply** at small scale (p. 2).");
  await page.locator(".chat-surface .composer-input").first().click();
  await page.keyboard.type("/");
  await page.keyboard.press("Enter");
  const side = page.getByRole("complementary", { name: "Side chat" });
  await side.getByRole("textbox", { name: "Side question", exact: true }).fill("Why?");
  await page.keyboard.press("Enter");
  const answer = side.locator(".side-chat-answer .prose-reading").last();
  await expect(answer.locator("strong.lead")).toHaveText("Short answer.");
  expect(Number(await style(answer.locator("strong.lead"), "font-weight"))).toBe(600);
  expect(await style(answer.locator("strong:not(.lead)"), "font-weight")).toBe(await style(answer.locator("p"), "font-weight"));
  await expect(answer.locator(".citation-link.is-aside")).toHaveText(["p. 2"]);
});

test("expanded, an answer's prose is as wide as its table, the question and the composer", async ({ page }) => {
  const wide = `| ${Array.from({ length: 12 }, (_, index) => `Setting ${index + 1}`).join(" | ")} |\n|${" --- |".repeat(12)}\n| ${Array.from({ length: 12 }, () => "0.001").join(" | ")} |`;
  await card(page, `${"The tuned frontier predicts the held-out scale within a narrow band. ".repeat(6)}\n\n${wide}`);
  await page.getByRole("button", { name: "Expand chat", exact: true }).click();
  await expect(page.locator(".kb-chat-rail.is-fullscreen")).toBeVisible();
  const answer = page.locator(".message.assistant .prose-reading").last();
  await expect.poll(() => page.locator(".chat-surface").evaluate((card) => card.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  const width = (locator: Locator) => locator.evaluate((node) => node.getBoundingClientRect().width);
  const prose = await width(answer.locator("p"));
  expect(prose).toBeGreaterThan(700);
  expect(Math.abs(prose - await width(answer.locator(".markdown-table-scroll")))).toBeLessThan(1);
  // Under the composer, edge to edge but for the turn's own 2px a side.
  const left = (locator: Locator) => locator.evaluate((node) => node.getBoundingClientRect().left);
  expect(Math.abs(await left(answer.locator("p")) - await left(page.locator(".chat-surface > .composer")))).toBeLessThan(3);
  expect(Math.abs(prose - await width(page.locator(".chat-surface > .composer")))).toBeLessThan(5);
});
