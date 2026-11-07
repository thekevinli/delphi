import { readFileSync } from "node:fs";

import { test, expect, type Page } from "@playwright/test";

/**
 * The recorded answers of `tests/recorded-answers.test.mts`, drawn by the real
 * chat panel: the document chat's renderer for an answer beside a document,
 * the Memory renderer for a Memory answer. The unit test reads the answer the
 * way the Sources list does; this reads what a reader actually sees, after
 * markdown has split the prose into bold runs, list items and code spans —
 * which is where most citations that once failed to link were lost.
 *
 * Every reference left in the drawn prose, outside a link, is a miss, found by
 * a detector that shares nothing with the parser.
 */

type Recorded = {
  name: string;
  scope: "document" | "memory";
  current: string | null;
  papers: Array<{ title: string; filename?: string | null; kind?: string | null }>;
  sources: Array<{ url: string; title: string }>;
  outside?: string[];
  outsideLibrary?: boolean;
  opens?: Record<string, string>;
  answer: string;
};

const recorded: Recorded[] = JSON.parse(readFileSync(new URL("../fixtures/recorded-answers.json", import.meta.url), "utf8"));
const CONVERSATION = "2".repeat(32);

/** The same detector as the unit test's, written separately on purpose. */
const REFERENCE = String.raw`(?:§§?\s*|(?<![\w.])(?:Tables?|Tab\.|Figures?|Figs?\.?|Sections?|Sec\.|Equations?|Eqs?\.|Eqns?\.|Algorithms?|Alg\.|Appendix|App\.|Theorems?|Lemmas?|Propositions?|Corollar(?:y|ies)|Definitions?)\s*)(?:\(\d+\)|[A-Z]?\d+(?:\.\d+)*|[A-Z]\b)|(?<![\w.])(?:pp?\.|pgs?\.|[Pp]ages?)\s*\d+`;

async function show(page: Page, answer: Recorded) {
  const papers = answer.papers.map((paper, index) => ({ id: `p${index}`, slug: `p${index}`, pages: 30, tokens: 0, ...paper }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/test/case") return route.fulfill({ json: { memory: answer.scope === "memory", papers, current: answer.current } });
    if (path.endsWith("/chat/conversations")) return route.fulfill({ json: {
      items: [{ id: CONVERSATION, generation: 0, title: answer.name, empty: false, manualTitle: false }], defaultId: CONVERSATION, limit: 10,
    } });
    if (path.endsWith("/chat")) return route.fulfill({ json: { images: [], messages: [
      { role: "user", content: "(question not recorded)", createdAt: "2026-10-30T00:00:00Z", requestId: "r1" },
      { role: "assistant", content: answer.answer, sources: answer.sources, createdAt: "2026-10-30T00:00:05Z", requestId: "r1" },
    ] } });
    // A Memory answer's library is the account's.
    if (path === "/api/dashboard") return route.fulfill({ json: { stats: {}, conversations: [], projects: [
      { id: "project", name: "Project", slug: "project", accentIndex: 0, totalCount: papers.length, activeCount: papers.length, lastEngagedAt: "",
        documents: papers.map((paper) => ({ ...paper, projectId: "project", projectName: "Project", projectSlug: "project" })) },
    ] } });
    if (path.endsWith("/anchors")) return route.fulfill({ json: { papers: {} } });
    return route.fulfill({ status: 404, json: { detail: `Unexpected test request ${path}` } });
  });
  await page.goto("/tests/browser/harness.html?answers");
  const body = page.locator(".message.assistant").last();
  await expect(body.locator(".message-markdown").first()).toBeVisible();
  // A Memory chat's library arrives after the answer's first paint.
  if (!answer.outsideLibrary) await expect(body.locator(".citation-link").first()).toBeVisible();
  return body;
}

for (const answer of recorded) {
  test(`${answer.name}: what the reader sees links every place it points at, and nothing else`, async ({ page }) => {
    const body = await show(page, answer);
    const { missed, drawn } = await body.evaluate((element, { pattern, outside }) => {
      const drawn: string[] = [];
      let text = "";
      for (const segment of element.querySelectorAll(".message-markdown")) {
        const copy = segment.cloneNode(true) as HTMLElement;
        drawn.push(...[...copy.querySelectorAll(".citation-link")].map((link) => link.textContent ?? ""));
        copy.querySelectorAll(".citation-link, code, pre, a, h1, h2, h3, h4, h5, h6, th, del, .katex, .web-citation").forEach((node) => node.replaceWith(" "));
        text += ` ${copy.textContent ?? ""}`;
      }
      for (const stretch of outside) text = text.split(stretch).join(" ");
      return { drawn, missed: [...text.matchAll(new RegExp(pattern, "g"))].map((match) => text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 20).replace(/\s+/g, " ")) };
    }, {
      pattern: REFERENCE,
      // An outside stretch as the page shows it: its markup gone.
      outside: (answer.outside ?? []).map((stretch) => stretch.replace(/\*\*|`/g, "")),
    });
    if (answer.outsideLibrary) {
      expect(drawn.filter((text) => !text.includes("§"))).toEqual([]);
      return;
    }
    expect(missed).toEqual([]);
  });
}

for (const answer of recorded.filter((item) => item.opens)) {
  test(`${answer.name}: a citation the reader follows opens the document its block is about`, async ({ page }) => {
    const body = await show(page, answer);
    for (const [written, document] of Object.entries(answer.opens ?? {})) {
      const link = body.locator(".citation-link", { hasText: written }).filter({ hasText: new RegExp(`^\\s*${written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
      await link.click();
      await expect(page.getByTestId("opened")).toHaveText(new RegExp(`^${document.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| `));
    }
  });
}
