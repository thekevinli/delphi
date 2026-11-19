import { expect, test } from "@playwright/test";

test("an answer keeps one trace: what it was handed, thought and did, per stretch", async ({ page }) => {
  await page.goto("/tests/browser/harness.html?trace");
  const answer = page.getByTestId("finished");

  // One fold per stretch, where it happened: before the answer, and between
  // its two paragraphs.
  const folds = answer.locator(".trace-fold-toggle");
  await expect(folds).toHaveText([
    "Thought for 0:09 · 6 steps · 2 pages",
    "Thought for 0:04 · 3 steps · 1 page",
  ]);
  const order = await answer.locator(":scope > *").evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(order).toEqual(["trace trace-fold", "message-markdown prose-reading", "trace trace-fold", "message-markdown prose-reading"]);
  // Folded, a stretch is one line; nothing of the timeline is drawn.
  await expect(answer.locator(".trace-row")).toHaveCount(0);

  await folds.first().click();
  const rows = answer.locator(".trace-fold").first().locator(".trace-timeline > .trace-row");
  // What the answer was handed leads, and is not a step: 6 steps, 8 rows.
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(0)).toContainText("Your question · nothing open beside the chat");
  await expect(rows.nth(1)).toContainText("Index: 97 pages · 26 documents · 22 chats");
  // A thought is prose, with the summary's markdown gone.
  await expect(rows.nth(2).locator(".trace-line")).toHaveText("Looking for Memory pages on speculative decoding");
  // A call is said as what was done, its argument as code, and never by name.
  await expect(rows.nth(3).locator("strong")).toHaveText("Searched page text");
  await expect(rows.nth(3).locator("code")).toHaveText("speculative[ -]decod|draft[ -]models?");
  await expect(rows.nth(4)).toContainText("Followed links from");
  await expect(answer).not.toContainText("grep_memory");
  // Each row carries its time from the start of the stretch.
  await expect(rows.locator(":scope > .trace-time")).toHaveText(["0:00", "0:00", "0:01", "0:02", "0:04", "0:05", "0:06", "0:09"]);

  // The pages a call returned sit under it; two with one title show their ids.
  const opened = rows.nth(6);
  await expect(opened.locator(".trace-line")).toHaveText("Opened 2 pages");
  await expect(opened.locator(".trace-result-tag")).toHaveText(["386a", "81a6"]);
  await opened.locator(".trace-result-title").nth(1).click();
  await expect(page.getByTestId("opened")).toHaveText("scaling-up-test-time-compute-with-latent-reason-81a69220ce2b");

  // A failed call stays where it happened, muted, with its reason at the end.
  await folds.nth(1).click();
  const failed = answer.locator(".trace-fold").nth(1).locator(".trace-tool.is-failed");
  await expect(failed).toHaveCount(1);
  await expect(failed.locator(".trace-time")).toHaveText("Not found · 0:01");

  // Nothing overflows the rail's width, however long a title or a pattern is.
  const box = (await answer.boundingBox())!;
  for (const row of await answer.locator(".trace-row").all()) {
    const inner = (await row.boundingBox())!;
    expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  if (process.env.TRACE_SHOT) await page.screenshot({ path: process.env.TRACE_SHOT, fullPage: true });
});

test("calls with no thoughts are a stretch that worked; a running stretch is open", async ({ page }) => {
  await page.goto("/tests/browser/harness.html?trace");
  await expect(page.getByTestId("worked").locator(".trace-fold-toggle")).toHaveText("Worked for 0:02 · 1 lookup · 1 page");

  // The stretch in progress is drawn open: the same rows, the call under way
  // in the present tense behind the mark, and no fold yet.
  const running = page.getByTestId("running");
  await expect(running.locator(".trace-fold-toggle")).toHaveCount(0);
  await expect(running.locator(".trace-row").first()).toContainText("Open document · On-Policy Distillation");
  // The Memory pages it was given are context, with the pages beneath.
  const given = running.locator(".trace-context").nth(2);
  await expect(given).toContainText("Given 1 page from your Memory");
  await expect(given.locator(".trace-result-title")).toHaveText("Reverse KL and dense token feedback");
  const active = running.locator(".trace-row.is-active");
  await expect(active).toHaveCount(1);
  await expect(active.locator("strong")).toHaveText("Searching page text");
  await expect(active.locator(".trace-mark")).toBeVisible();

  // Before anything has arrived there is one row: a phrase, the mark and a clock.
  const waiting = page.getByTestId("waiting").locator(".trace-row");
  await expect(waiting).toHaveCount(1);
  await expect(waiting.locator(".trace-time")).toHaveText(/^0:0\d$/);
});
