import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { traceGoldenCases } from "./trace-golden-fixtures";

/**
 * The reasoning trace, pinned.
 *
 * `trace-golden.txt` is what a reader sees for every fixture trace, as text:
 * the fold line, each row's kind, its bold verb, its argument, its time, its
 * hover title, and the result rows under it. It is the same in both engines.
 * The screenshots beside it pin how the designed states are drawn.
 *
 * A difference fails. If the difference was meant, review it and rewrite the
 * goldens:
 *
 *   UPDATE_TRACE_GOLDEN=1 pnpm test:browser trace-golden --update-snapshots
 */
const GOLDEN = fileURLToPath(new URL("./trace-golden.txt", import.meta.url));

/** The states the trace was designed for, pinned as pictures as well as text. */
const PICTURED = ["designed", "worked-only", "running", "thinking-only", "memory-chat", "s10-a-tool-fails", "web-search-open-find"];

test.beforeEach(async ({ page }) => {
  // A running stretch reads the clock; a fixed one makes it say the same thing every run.
  await page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z"));
  await page.goto("/tests/browser/harness.html?goldens");
  await expect(page.getByTestId(`golden-${traceGoldenCases[0].name}`)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});

/** One turn as lines of text. Runs in the page. */
function describeTurn(root: Element): string[] {
  const lineText = (node: Element | null) => Array.from(node?.childNodes ?? []).map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
    const element = child as Element;
    if (element.tagName === "STRONG") return `**${element.textContent}**`;
    if (element.tagName === "CODE") return `\`${element.textContent}\``;
    if (element.tagName === "A") return `[\`${element.textContent}\`](${element.getAttribute("href")} ${element.getAttribute("target")} ${element.getAttribute("rel")})`;
    return element.textContent ?? "";
  }).join("");
  const glyphOf = (row: Element) => {
    if (row.querySelector(":scope > .trace-lead .trace-mark")) return "mark";
    const svg = row.querySelector(":scope > .trace-lead .trace-glyph");
    if (!svg) return row.querySelector(":scope > .trace-lead .trace-dash") ? "dash" : "dot";
    let hash = 2166136261;
    for (const char of svg.innerHTML) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return `glyph ${hash.toString(16).padStart(8, "0")}`;
  };
  const lines: string[] = [];
  for (const child of Array.from(root.children)) {
    if (child.classList.contains("message-markdown")) { lines.push(`text: ${child.textContent}`); continue; }
    if (!child.classList.contains("trace")) continue;
    const toggle = child.querySelector(".trace-fold-toggle");
    lines.push(toggle ? `fold: ${toggle.textContent}` : "running:");
    for (const row of Array.from(child.querySelectorAll(".trace-timeline > .trace-row"))) {
      const kind = ["context", "thought", "tool", "earlier", "waiting"].find((name) => row.classList.contains(`trace-${name}`)) ?? "row";
      const flags = ["failed", "active"].filter((name) => row.classList.contains(`is-${name}`));
      const time = row.querySelector(":scope > .trace-time")?.textContent ?? "";
      // A waiting phrase is drawn from a shuffled list; that there is one is the fact.
      const body = kind === "waiting" ? "(a waiting phrase)" : lineText(row.querySelector(".trace-line"));
      const hover = row.getAttribute("title");
      lines.push(`  [${[kind, ...flags].join(" ")}] <${glyphOf(row)}> ${body}${time ? `  @ ${time}` : ""}${hover ? `  {${hover}}` : ""}`);
      for (const result of Array.from(row.querySelectorAll(".trace-results > li"))) {
        const mark = Array.from(result.querySelector(".trace-kind")?.classList ?? []).find((name) => name.startsWith("trace-kind-"))?.slice(11) ?? "?";
        const title = result.querySelector(".trace-result-title");
        const tag = result.querySelector(".trace-result-tag")?.textContent;
        const leaves = title?.tagName === "A" ? ` [leaves to ${title.getAttribute("href")} ${title.getAttribute("target")} ${title.getAttribute("rel")}]` : "";
        lines.push(`      - (${mark}) ${title?.textContent ?? ""}${title?.tagName === "BUTTON" ? " [opens]" : ""}${leaves}${tag ? ` #${tag}` : ""}`);
      }
    }
  }
  return lines;
}

test("the trace reads exactly as its golden says, folded and open", async ({ page }) => {
  const sections: string[] = [];
  const folded = new Map<string, string[]>();
  for (const item of traceGoldenCases) folded.set(item.name, await page.getByTestId(`golden-${item.name}`).evaluate(describeTurn));
  // Every fold is opened, in every turn, and the same turns are read again.
  for (const toggle of await page.locator(".trace-fold-toggle").all()) await toggle.click();
  for (const item of traceGoldenCases) {
    const open = await page.getByTestId(`golden-${item.name}`).evaluate(describeTurn);
    sections.push(`== ${item.name}`, ...folded.get(item.name)!, "-- opened", ...open, "");
  }
  const actual = sections.join("\n");
  if (process.env.UPDATE_TRACE_GOLDEN) writeFileSync(GOLDEN, actual);
  expect(existsSync(GOLDEN), "no golden yet: run once with UPDATE_TRACE_GOLDEN=1 and review the file").toBe(true);
  expect(actual).toBe(readFileSync(GOLDEN, "utf8"));
  // The row never says a tool by its id; the id is on hover alone.
  const visible = actual.replace(/\{[^}\n]*\}/g, "");
  for (const id of ["open_memory", "grep_memory", "memory_links", "read_paper", "read_webpage", "search_library", "view_figure", "web_search"]) {
    expect(visible, id).not.toContain(id);
  }
});

test("the designed states are drawn as their pictures", async ({ page }, testInfo) => {
  // Pixels are compared where they were captured; text above is compared everywhere.
  test.skip(process.platform !== "darwin", "screenshots are pinned on macOS");
  testInfo.snapshotSuffix = "";
  for (const toggle of await page.locator(".trace-fold-toggle").all()) await toggle.click();
  for (const name of PICTURED) {
    await expect(page.getByTestId(`golden-${name}`)).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.01 });
  }
});
