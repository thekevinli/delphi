import { expect, test, type Page } from "@playwright/test";

/*
 * The reader's filing card on its real client against a scripted queue: what
 * it says after each press, and how it moves on as the queue does. The page's
 * clock is installed so the card's polls run when the test says.
 */
type Job = { id: string; kind: "document"; marker: string; payload: { paperId: string }; label: string; status: "pending" | "leased" | "failed";
  leaseExpiresAt: string | null; retryAt: string | null; lastError: string | null; attempts: number;
  failure: { cause: string; failedAt: string; pages: never[] } | null };
type Record = { filed: boolean; queued: boolean; stuck: boolean; stale: boolean; dropped: { slug: string; title: string; action: string; reason: string; quote: string }[];
  sameAs?: { slug: string; title: string; deletedAt: string | null } | null };

async function queue(page: Page, record: Record) {
  const state = { record, jobs: [] as Job[], filed: [] as string[][], answered: [] as { use: boolean }[] };
  const job = (status: Job["status"], extra: Partial<Job> = {}): Job => ({ id: "job-1", kind: "document", marker: "paper:paper1", payload: { paperId: "paper1" }, label: "Cuts and flashes",
    status, leaseExpiresAt: null, retryAt: null, lastError: null, attempts: 0, failure: null, ...extra });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/memory/documents/paper1/filing") return route.fulfill({ json: { sameAs: null, ...state.record, filedVersion: null, version: "v" } });
    if (url.pathname === "/api/memory/documents/paper1/same-as") {
      state.answered.push(route.request().postDataJSON());
      state.record = { ...state.record, sameAs: null };
      state.jobs = [job("pending")];
      return route.fulfill({ json: { used: true } });
    }
    if (url.pathname === "/api/memory/backfill/papers") {
      state.filed.push(route.request().postDataJSON().paperIds);
      state.record = { ...state.record, queued: true };
      state.jobs = [job("pending")];
      return route.fulfill({ json: {} });
    }
    if (url.pathname === "/api/memory/maintenance/drain") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done","claimed":false}\n\n' });
    if (url.pathname === "/api/memory/maintenance") {
      return route.fulfill({ json: { pending: state.jobs.length, leased: 0, cancellable: state.jobs.length, failed: 0, due: 0, jobs: state.jobs, maxAttempts: 3 } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return { state, job };
}

const card = (page: Page) => page.locator(".filing-progress");
/** Why a try failed, as the server names it. */
const provider: Job["failure"] = { cause: "provider", failedAt: "2026-09-30T12:00:00Z", pages: [] };

test("a refused page is retried, waits in line, runs, and leaves the rail once Memory has it", async ({ page }) => {
  await page.clock.install();
  const { state, job } = await queue(page, { filed: true, queued: false, stuck: false, stale: false, dropped: [
    { slug: "muon", title: "Muon optimizer", action: "create", reason: "The update rule it states is not in the passage it cites.", quote: "" },
    { slug: "newton-schulz", title: "Newton–Schulz iteration", action: "create", reason: "Cites a figure the document does not have.", quote: "" },
  ] });
  await page.goto("/tests/browser/harness.html?filing-workflow");

  await expect(card(page).getByText("2 pages weren’t written")).toBeVisible();
  await expect(card(page).locator(".filing-progress-pages li")).toHaveCount(2);
  await expect(card(page).getByText("Cites a figure the document does not have.")).toBeVisible();
  await card(page).getByRole("button", { name: "Retry document" }).click();

  // The press refiles the whole document and the card says so at once.
  await expect.poll(() => state.filed).toEqual([["paper1"]]);
  await expect(card(page).getByText("Updating this document in Memory")).toBeVisible();
  await expect(card(page).getByText("Queued · starting soon")).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(0);

  // A tab claims the job: the same card shows the steps.
  state.jobs = [job("leased", { leaseExpiresAt: "2999-01-01T00:00:00.000Z" })];
  await page.clock.fastForward(5000);
  await expect(card(page).getByText(/^Step 1 of 4/)).toBeVisible();
  await expect(card(page).getByRole("list", { name: "Filing steps" }).locator("li")).toHaveCount(4);

  // The pass finishes clean: the card goes, and the rail is told to redraw.
  state.jobs = [];
  state.record = { filed: true, queued: false, stuck: false, stale: false, dropped: [] };
  await page.clock.fastForward(15000);
  await expect(card(page)).toHaveCount(0);
  // Once for the press, once when the poll finds the queue empty.
  await expect(page.getByTestId("filed")).toHaveText("2");
});

test("a new document is filed, retries on its own with the reason, and offers Try again once it gives up", async ({ page }) => {
  await page.clock.install();
  const { state, job } = await queue(page, { filed: false, queued: false, stuck: false, stale: false, dropped: [] });
  await page.goto("/tests/browser/harness.html?filing-workflow&unfiled");

  await expect(card(page).getByText("Not in your Memory yet")).toBeVisible();
  await card(page).getByRole("button", { name: "File it now" }).click();
  await expect.poll(() => state.filed).toEqual([["paper1"]]);
  await expect(card(page).getByText("Filing into Memory")).toBeVisible();
  await expect(card(page).getByText("Queued · starting soon")).toBeVisible();

  // The provider turned it away: the job is owed a retry, and the card says why.
  state.jobs = [job("failed", { lastError: "Client error '429 Too Many Requests' for url 'https://api.openai.com/v1/responses'", retryAt: "2999-01-01T00:00:00.000Z", attempts: 1, failure: provider })];
  await page.clock.fastForward(5000);
  await expect(card(page).getByText("Did not finish · trying again soon")).toBeVisible();
  await expect(card(page).getByText("Provider unavailable. Busy, down or past your plan’s limit.")).toBeVisible();
  await expect(page.getByText("Delphi retries on its own. Keep reading.")).toBeVisible();

  // It reaches its attempt ceiling: one verb to start over.
  state.jobs = [];
  state.record = { filed: false, queued: false, stuck: true, stale: false, dropped: [] };
  await page.clock.fastForward(15000);
  await expect(card(page).getByText("Filing didn’t finish")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Try again" })).toHaveClass(/primary-button/);
  await expect(page.getByText("Trying again starts the filing from the beginning.")).toBeVisible();
});

test("a document like one the reader deleted asks before using its kept page, and the answer lets it file", async ({ page }) => {
  await page.clock.install();
  const { state } = await queue(page, { filed: false, queued: true, stuck: false, stale: false, dropped: [],
    sameAs: { slug: "dkv-cache", title: "dKV-Cache: The Cache for Diffusion Language Models", deletedAt: "2026-10-09T15:00:00+00:00" } });
  await page.goto("/tests/browser/harness.html?filing-workflow&unfiled");

  // Waiting on the reader is the whole card, in place of the queue's progress.
  await expect(page.getByRole("region", { name: "Same as dKV-Cache: The Cache for Diffusion Language Models?" })).toBeVisible();
  await expect(card(page).getByText("Same as page")).toBeVisible();
  await expect(card(page).getByText("Original document deleted Oct 9")).toBeVisible();
  await expect(page.getByText("Filing waits until you choose.")).toBeVisible();
  await expect(card(page).getByText("Queued · starting soon")).toHaveCount(0);

  // The kept page's name opens it, so the reader can look before answering.
  const kept = card(page).getByRole("link", { name: "dKV-Cache: The Cache for Diffusion Language Models" });
  await expect(kept).toHaveAttribute("href", "/memory?page=dkv-cache");
  await kept.click();
  await expect(page.getByTestId("opened")).toHaveText("dkv-cache");

  // At the rail's default width the two answers sit side by side, inside the card.
  await page.locator(".reader-unfiled").evaluate((rail: HTMLElement) => { rail.style.width = "255px"; });
  const fit = await card(page).evaluate((section) => {
    const inner = section.getBoundingClientRect().right - 12;
    const [use, keep] = [...section.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return { inside: use.right <= inner && keep.right <= inner, oneRow: Math.abs(use.top - keep.top) < 1 };
  });
  expect(fit).toEqual({ inside: true, oneRow: true });

  await card(page).getByRole("button", { name: "Use that page" }).click();
  await expect.poll(() => state.answered).toEqual([{ use: true }]);
  await expect(card(page).getByText("Queued · starting soon")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Use that page" })).toHaveCount(0);
});

test("the library still hears the queue move after the document's card has closed", async ({ page }) => {
  await page.clock.install();
  const { state, job } = await queue(page, { filed: false, queued: true, stuck: false, stale: false, dropped: [] });
  await page.goto("/tests/browser/harness.html?filing-queue");
  await expect(card(page).getByText("Queued · starting soon")).toBeVisible();
  await expect(page.getByTestId("library")).toHaveText("idle");

  // The card goes and its last poll finds nothing owed, so only news of the queue can move the library now.
  await page.getByRole("button", { name: "Close the card" }).click();
  await expect(card(page)).toHaveCount(0);
  const idle = page.waitForResponse(response => new URL(response.url()).pathname === "/api/memory/maintenance");
  await page.clock.fastForward(5000);
  await idle;

  // This tab's drain claims a job queued elsewhere: the library reads the queue again and marks the document.
  state.jobs = [job("pending")];
  await page.route("**/api/memory/maintenance/drain", route => route.fulfill({ contentType: "text/event-stream",
    body: 'data: {"type":"progress"}\n\ndata: {"type":"done","claimed":false}\n\n' }));
  await page.getByRole("button", { name: "Run the queue" }).click();
  await expect(page.getByTestId("library")).toHaveText("queued");
});

test("a first filing cut short after its page is written shows the retry, then says at once when it gives up", async ({ page }) => {
  await page.clock.install();
  const { state, job } = await queue(page, { filed: false, queued: true, stuck: false, stale: false, dropped: [] });
  state.jobs = [job("failed", { lastError: "deadline: the selection did not answer in time", retryAt: "2999-01-01T00:00:00.000Z", attempts: 1, failure: provider })];
  await page.goto("/tests/browser/harness.html?filing-workflow");
  await expect(card(page).getByText("Filing into Memory")).toBeVisible();
  await expect(card(page).getByText("Did not finish · trying again soon")).toBeVisible();
  // A deadline is the provider's: it answered too slowly.
  await expect(card(page).getByText("Provider unavailable. Busy, down or past your plan’s limit.")).toBeVisible();

  // The third attempt fails in this window's drain: the card says so without waiting for its own poll.
  state.jobs = [job("failed", { lastError: "deadline: the selection did not answer in time", retryAt: null, attempts: 3, failure: provider })];
  state.record = { filed: false, queued: false, stuck: true, stale: false, dropped: [] };
  await page.route("**/api/memory/maintenance/drain", route => route.fulfill({ contentType: "text/event-stream",
    body: 'data: {"type":"progress"}\n\ndata: {"type":"error","jobId":"job-1","message":"deadline"}\n\n' }), { times: 1 });
  await page.getByRole("button", { name: "Run the queue" }).click();
  await expect(card(page).getByText("Filing didn’t finish")).toBeVisible();
  await expect(card(page).getByText("Only its own page is in Memory so far")).toBeVisible();
  await expect(page.getByText("trying again soon")).toHaveCount(0);
  // The rail is told too, so a card drawn before the page existed is replaced by this one.
  await expect(page.getByTestId("filed")).toHaveText("1");
});

test("a job that gave up is never shown as trying again, and the library alone reads nothing through a retry's wait", async ({ page }) => {
  await page.clock.install();
  const { state, job } = await queue(page, { filed: false, queued: true, stuck: false, stale: false, dropped: [] });
  state.jobs = [job("failed", { lastError: "deadline: x", retryAt: null, attempts: 3 })];
  await page.goto("/tests/browser/harness.html?filing-queue");
  await expect(card(page)).toBeVisible();
  await expect(page.getByText("trying again soon")).toHaveCount(0);

  // A retry that is minutes away is not work the library can show, so with the card gone nothing polls for it.
  state.jobs = [job("failed", { lastError: "deadline: x", retryAt: "2999-01-01T00:00:00.000Z", attempts: 1 })];
  await page.getByRole("button", { name: "Close the card" }).click();
  const last = page.waitForResponse(response => new URL(response.url()).pathname === "/api/memory/maintenance");
  await page.clock.fastForward(5000);
  await last;
  for (let poll = 0; poll < 2; poll++) {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === "/api/memory/maintenance", { timeout: 1500 });
    await page.clock.fastForward(5000);
    await expect(read).rejects.toThrow();
  }
  await expect(page.getByTestId("library")).toHaveText("idle");
});
