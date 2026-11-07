import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { freePort } from "../../../main/ports.ts";
import { startWorkerHost } from "../../../main/worker-host.ts";
import { DEFAULT_APP_CONFIG, type DashboardConversation, type MemoryOverview, type MemoryPage, type MemoryPageDetail, type MemoryPageSummary } from "../../app/lib/api.ts";
import type { BackfillCandidate } from "../../app/lib/backfill.ts";
import type { ConversationSummary } from "../../app/lib/conversation-session.ts";
import { releaseUnheard } from "./unheard-release-fixture.ts";

// Use the production router: mounting a fresh harness at each URL would hide
// stale domain focus in the shell the router reuses across Memory views.
let host: Awaited<ReturnType<typeof startWorkerHost>>;
let origin: string;
test.beforeAll(async () => {
  const port = await freePort("127.0.0.1");
  origin = `http://127.0.0.1:${port}`;
  host = await startWorkerHost({
    distDir: fileURLToPath(new URL("../../../.delphi-build/dist", import.meta.url)),
    backendUrl: "http://127.0.0.1:9",
    uiHost: "127.0.0.1",
    uiPort: port,
    desktopHandler: async (request) => {
      if (new URL(request.url).pathname === "/api/memory/sessions/release") releases.push(await request.text());
      return fixtureResponse(request);
    },
  });
});
test.afterAll(async () => {
  if (host) await new Promise<void>((resolve, reject) => host.close((error) => error ? reject(error) : resolve()));
});

const now = "2026-09-30T12:00:00Z";
function memoryPage(slug: string, domain: string, kind: MemoryPage["kind"], title: string): MemoryPage {
  return {
    id: slug, slug, domain, kind, title, summary: "A topic in your Memory.", tags: [], revision: 1,
    createdAt: now, updatedAt: now, linkDegree: 1,
    body: "Some prose explaining this topic.", citations: [], links: [], figures: [],
  };
}
// A concept citing an outside source, whose prose holds a run with nowhere to break.
const longRun = `/${"averyverylongdirectoryname".repeat(12)}`;
const concept: MemoryPage = {
  ...memoryPage("alpha-concept", "alpha", "concept", "Alpha Concept"),
  body: `A claim the outside page makes [E1]. It was read at ${longRun}, as [[beta-source]] was.`,
  citations: [{ id: 1, claimType: "external", evidenceId: "capture", section: "intro" }],
};
// Alpha has a page written for it, under a title its record has since been
// renamed away from. Beta has none: it is its record and what is filed there.
const pages = [
  memoryPage("alpha", "alpha", "domain", "alpha, as first written"),
  concept,
  memoryPage("beta-source", "beta", "source", "Beta Source"),
];
const overview: MemoryOverview = {
  version: "1", revision: 1, statistics: { pages: 3, links: 1, domains: 2 },
  pages,
  domains: ["alpha", "beta"].map((slug, position) => ({
    slug, domain: slug, title: slug === "alpha" ? "Alpha" : "Beta", summary: "", origin: "reader", position, pages: 1,
  })),
  // The second edge names a page that was never written.
  links: [{ from: "alpha", to: "alpha-concept" }, { from: "beta-source", to: "never-written" }],
  events: [],
};
const chat = (id: string, title: string): ConversationSummary => ({ id, generation: 1, title, empty: false, lastEngagedAt: now });
const first = chat("a".repeat(32), "First chat");
const second = chat("b".repeat(32), "Second chat");
/** The Memory chats there are, as the rail lists them and as Settings lists them. */
let memoryChats: ConversationSummary[] = [first];
let listedChats: ConversationSummary[] = [first];
test.beforeEach(() => { memoryChats = [first]; listedChats = [first]; });
/** What each session release named, in order: an empty body releases every one. */
const releases: string[] = [];
const candidate: BackfillCandidate = {
  projectId: "project", paperId: "paper", projectName: "Library", title: "Pending paper",
  digestReady: true, filed: false, stale: false, dropped: [], filedVersion: null,
};

// Opened by address only, so the map and its counts stay those above.
const linked: MemoryPageDetail = {
  page: {
    ...memoryPage("linked-markers", "alpha", "concept", "Linked markers"),
    body: "Prefix reuse [E1] is shown [in **[E1]** of *[[alpha-concept]]*](#details).",
    citations: [{ id: 1, claimType: "author-claim", paperId: "paper", page: 2 }],
  },
  sources: [{ paperId: "paper", projectId: "project", title: "Pending paper", passages: 1, pages: [2], sections: [], available: true }],
  backlinks: [],
};

/** Home's recent threads; empty unless a test names some. */
let threads: DashboardConversation[] = [];

function fixtureResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return;
  let value: unknown;
  switch (url.pathname) {
    case "/api/auth/me": value = { username: "reader", useStandardTier: true }; break;
    case "/api/config": value = { ...DEFAULT_APP_CONFIG, memoryEnabled: true }; break;
    case "/api/memory": value = overview; break;
    case "/api/onboarding/resolve": value = { onboarding: false }; break;
    case "/api/dashboard":
      value = { stats: { projects: 0, documents: 0, completed: 0, completedPercent: 0 }, conversations: threads, projects: [] };
      break;
    case "/api/projects": value = []; break;
    case "/api/personas": value = { official: [], mine: [] }; break;
    case "/api/chat/conversations":
      value = url.searchParams.get("scope") === "general"
        ? { items: memoryChats, defaultId: memoryChats[0]?.id ?? null, limit: 10 }
        : { items: [], defaultId: null, limit: 10 };
      break;
    case "/api/chat": value = { messages: [], images: [] }; break;
    case "/api/conversations":
      value = listedChats.map(({ id, title }) => ({ id, kind: "memory_chat", title, lastEngagedAt: now }));
      break;
    case "/api/evidence/capture":
      value = {
        id: "capture", url: "https://outside.example/a", finalUrl: "https://outside.example/a", title: "Outside page",
        capturedAt: now, findings: [], sections: [{ anchor: "intro", title: "Intro", level: 2, markdown: "What the outside page said." }],
      };
      break;
    case "/api/memory/health":
      value = { pages: 3, computedAt: now, orphans: [], uncapturedFigures: [], droppedTargets: [], lastCheck: null };
      break;
    case "/api/memory/maintenance":
      value = { pending: 0, leased: 0, cancellable: 0, failed: 0, due: 0, jobs: [], maxAttempts: 3 };
      break;
    case "/api/memory/sessions/release": value = { released: 0 }; break;
    case "/api/memory/maintenance/drain":
      return new Response('data: {"type":"done","claimed":false}\n\n', { headers: { "content-type": "text/event-stream" } });
    case "/api/memory/backfill/papers": value = { papers: [] }; break;
    case "/api/memory/neighborhood":
      value = { ...overview, center: pages.find((entry) => entry.slug === url.searchParams.get("slug")) ?? null, distances: {} };
      break;
    default:
      if (url.pathname === `/api/memory/pages/${linked.page.slug}`) {
        value = linked;
      } else if (url.pathname.startsWith("/api/memory/pages/")) {
        const found = pages.find((entry) => entry.slug === url.pathname.split("/").pop());
        // A domain with no written page has no page: the route answers 404.
        if (!found) return Response.json({ detail: "Memory page not found" }, { status: 404 });
        value = { page: found, sources: [], backlinks: [] };
      } else {
        return Response.json({ detail: "No fixture for this route" }, { status: 404 });
      }
  }
  return Response.json(value);
}

/** A domain's chevron, which folds it and zooms the map onto it. */
function folder(page: Page, title: string) {
  return page.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${title}$`) });
}
/** A domain's name, which opens the page written for it when there is one. */
function folderName(page: Page, title: string) {
  return page.locator(".kb-memory-domain-name").filter({ hasText: title });
}
async function focusedOn(page: Page, title: "Alpha" | "Beta") {
  await expect(page.getByRole("navigation", { name: "Map position" }).locator("strong")).toHaveText(title);
  await expect(folder(page, title)).toHaveAttribute("aria-expanded", "true");
  await expect(folder(page, title === "Alpha" ? "Beta" : "Alpha")).toHaveAttribute("aria-expanded", "false");
}
/** The graph is a canvas: it writes where its names landed onto itself. */
function graphCanvas(page: Page) {
  return page.locator(".kb-graph-canvas canvas");
}
async function pageNames(page: Page): Promise<string[]> {
  return JSON.parse((await graphCanvas(page).getAttribute("data-pages")) ?? "[]");
}
/** Presses a domain's name on the map itself, where the reader would — once
 *  the camera has stopped easing, so the name is still where it was read. */
async function pressDomainName(page: Page, slug: string) {
  const canvas = graphCanvas(page);
  let last = "";
  await expect.poll(async () => {
    const now = (await canvas.getAttribute("data-domains")) ?? "";
    const still = now === last && now.includes(`"${slug}"`);
    last = now;
    return still;
  }, { intervals: [150] }).toBe(true);
  const { x, y } = (JSON.parse(last) as Array<{ slug: string; x: number; y: number }>).find((entry) => entry.slug === slug)!;
  await canvas.click({ position: { x, y } });
}
async function viewSelected(page: Page, view: "Map" | "Health") {
  await expect(page.getByRole("tab", { name: view, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".kb-memory-toggle")).toHaveCSS("--segment-index", view === "Map" ? "0" : "1");
}

test("a bookmark from before 0.7.0 opens the same Memory page at its new address", async ({ page }) => {
  // L16: the old address, as readers' bookmarks hold it.
  await page.goto(`${origin}/knowledge-base?page=beta-source`);
  await expect(page).toHaveURL(`${origin}/memory?page=beta-source`);
  await expect(page.getByRole("heading", { name: "Beta Source", exact: true })).toBeVisible();
  await page.goto(`${origin}/knowledge-base/graph?domain=beta`);
  await expect(page).toHaveURL(`${origin}/memory/graph?domain=beta`);
  await focusedOn(page, "Beta");
});

test("Back to map adopts the page's domain without a reload", async ({ page }) => {
  await page.goto(`${origin}/memory?page=beta-source`);
  await expect(page.getByRole("heading", { name: "Beta Source", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to map" }).click();
  await expect(page).toHaveURL(`${origin}/memory/graph?domain=beta`);
  await focusedOn(page, "Beta");
  await page.reload();
  await focusedOn(page, "Beta");
});

test("a marker or Memory link inside a formatted link reads as its words, never a second link", async ({ page }) => {
  await page.goto(`${origin}/memory?page=linked-markers`);
  const prose = page.locator("article.kb-prose");
  await expect(prose.getByRole("link", { name: "E1", exact: true })).toHaveAttribute("href", "#E1");
  const outer = prose.getByRole("link", { name: "in (E1) of Alpha Concept" });
  await expect(outer.locator("strong")).toHaveText("(E1)");
  await expect(outer.locator("a, button")).toHaveCount(0);
  await expect(prose.getByRole("link")).toHaveCount(2);
});

test("Health domain choices and history synchronize the map and toggle", async ({ page }) => {
  await page.goto(`${origin}/memory/graph`);
  await expect(folder(page, "Beta")).toBeVisible();
  // Local map focus should survive a Health visit even though it has no query.
  await folder(page, "Beta").click();
  await focusedOn(page, "Beta");
  await page.getByRole("tab", { name: "Health", exact: true }).click();
  await viewSelected(page, "Health");
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/memory/graph?domain=beta`);
  await focusedOn(page, "Beta");
  await viewSelected(page, "Map");

  await page.getByRole("tab", { name: "Health", exact: true }).click();
  await viewSelected(page, "Health");
  await folder(page, "Alpha").click();
  await expect(page).toHaveURL(`${origin}/memory/graph?domain=alpha`);
  await focusedOn(page, "Alpha");
  await viewSelected(page, "Map");
  await page.goBack();
  await viewSelected(page, "Health");
  await page.goBack();
  await focusedOn(page, "Beta");
  await page.goBack();
  await viewSelected(page, "Health");
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/memory/graph`);
  await viewSelected(page, "Map");
  await expect(page.getByRole("navigation", { name: "Map position" })).toHaveCount(0);
  await expect(page.locator('.kb-memory-domain-toggle[aria-expanded="true"]')).toHaveCount(0);
});

test("the full map names its pages all the time, and a domain's name zooms onto it", async ({ page }) => {
  await page.goto(`${origin}/memory/graph`);
  await expect.poll(() => pageNames(page)).toEqual(expect.arrayContaining(["Alpha Concept", "Beta Source"]));
  // The same focus the rail sets, and like the rail's it is local to the map.
  await pressDomainName(page, "beta");
  await focusedOn(page, "Beta");
  await expect.poll(() => pageNames(page)).toContain("Beta Source");
  await expect.poll(() => pageNames(page)).not.toContain("Alpha Concept");
  // The rail zooms the same camera.
  await folder(page, "Alpha").click();
  await focusedOn(page, "Alpha");
  await expect.poll(() => pageNames(page)).toContain("Alpha Concept");
});

test("a pan let go where the page never heard it stops where it was let go", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "how Chromium ends a capture it never saw released");
  await page.goto(`${origin}/memory/graph`);
  await expect.poll(() => pageNames(page)).toEqual(expect.arrayContaining(["Alpha Concept", "Beta Source"]));
  const canvas = graphCanvas(page);
  /** Where the domains are drawn, once the camera has stopped moving. */
  const settled = async () => {
    let last = "";
    await expect.poll(async () => {
      const now = (await canvas.getAttribute("data-domains")) ?? "";
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [150] }).toBe(true);
    return last;
  };
  // Zoomed in, so a pan has room to move the camera at all.
  await page.getByRole("button", { name: "Zoom in" }).click();
  const home = await settled();
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 6 });
  const panned = await settled();
  expect(panned).not.toBe(home);
  await releaseUnheard(page, x + 60, y + 40);
  // The hand goes on across the map; the camera stays where it was let go.
  await page.mouse.move(x + 200, y + 140, { steps: 6 });
  expect(await settled()).toBe(panned);
  await page.mouse.up();
});

test("a domain's name opens the page written for it, and without one shows what is filed there", async ({ page }) => {
  await page.goto(`${origin}/memory/graph`);
  // The heading is the record's name, not the title the page was written under.
  await expect(folderName(page, "Alpha")).toHaveText(/^Alpha\s*1$/);
  await expect(page.locator(".kb-memory-domain-name")).toHaveCount(2);

  // No page: the name does what the chevron does, and the reader stays on the map.
  await folderName(page, "Beta").click();
  await focusedOn(page, "Beta");
  await expect(page.locator(".kb-memory-pages").getByRole("button", { name: "Beta Source" })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/memory/graph`);

  // A written page: the name opens it.
  await folderName(page, "Alpha").click();
  await expect(page).toHaveURL(`${origin}/memory?page=alpha`);
  await expect(page.getByRole("heading", { name: "alpha, as first written", exact: true })).toBeVisible();
});

test("Memory shows three kinds and nothing of the pages it no longer keeps", async ({ page }) => {
  await page.goto(`${origin}/memory/graph`);
  // A link to a page never written is neither a circle nor a name on the map.
  await expect.poll(() => pageNames(page)).toEqual(expect.arrayContaining(["Alpha Concept", "Beta Source"]));
  expect(await pageNames(page)).not.toContain("never-written");
  await folder(page, "Beta").click();
  await expect(page.locator(".kb-memory-dot-source")).toHaveCount(1);
  // Memory's own classes only: the loading mark and the chat name theirs otherwise.
  await expect(page.locator('[class*="kb-"][class*="-gap"], [class*="kb-"][class*="-question"], [class*="kb-"][class*="-synthesis"], [class*="unresolved"]')).toHaveCount(0);

  await page.goto(`${origin}/memory?page=alpha-concept`);
  await expect(page.locator(".kb-kind-concept")).toHaveText("Concept");
  await expect(page.locator(".kb-page-level, .kb-link-unresolved")).toHaveCount(0);

  // A page that is not there says so, and says nothing about gaps.
  await page.goto(`${origin}/memory?page=never-written`);
  await expect(page.getByText("This page no longer exists.", { exact: true })).toBeVisible();
  await expect(page.locator("main.kb-page")).not.toContainText(/gap|not written yet|hub/i);
});

test("Home loads KaTeX only once a thread's title holds math", async ({ page }) => {
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(".js")) scripts.push(response.text().catch(() => ""));
  });
  const thread = (title: string): DashboardConversation => ({ id: title, kind: "memory_chat", title, lastEngagedAt: now });
  const katexLoaded = async () => (await Promise.all(scripts)).some((body) => body.includes("KaTeX parse error"));
  try {
    threads = [thread("Plain words only")];
    await page.goto(`${origin}/`);
    await expect(page.locator(".dashboard-thread strong")).toHaveText("Plain words only");
    await page.waitForLoadState("networkidle");
    expect(await katexLoaded()).toBe(false);

    threads = [thread(String.raw`Why $x_t$ drifts`)];
    await page.reload();
    await expect(page.locator(".dashboard-thread strong .katex")).toHaveCount(1);
    expect(await katexLoaded()).toBe(true);
  } finally {
    threads = [];
  }
});

test("Home's titles open their detail, and the collapsed rail's tools work without opening it", async ({ page }) => {
  threads = [{ id: "t", kind: "memory_chat", title: "A thread", lastEngagedAt: now }];
  try {
    await page.goto(`${origin}/`);
    const rail = page.locator(".dashboard-sidebar");
    await expect(rail).toHaveClass(/is-collapsed/);
    // Settings straight from its icon, the rail left as it was. Collapsed, a
    // tool takes the pointer on its icon's square only, 17px into the button.
    await page.getByRole("button", { name: "Settings", exact: true }).click({ position: { x: 17, y: 18 } });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(rail).toHaveClass(/is-collapsed/);
    await page.getByRole("button", { name: "Close settings" }).click();
    // Hovered, the icon looks around and its name shows beside the rail.
    const searchTool = page.getByRole("button", { name: "Search (⌘K)" });
    await searchTool.hover({ position: { x: 17, y: 18 } });
    await expect(page.locator(".desktop-rail-tip.is-shown")).toHaveText("Search⌘K");
    expect(await searchTool.locator("svg").evaluate((icon) => icon.getAnimations().length)).toBe(1);
    // The gap between the tools is rail, not a tool: it expands.
    const search = await page.getByRole("button", { name: "Search (⌘K)" }).boundingBox();
    const settings = await page.getByRole("button", { name: "Settings", exact: true }).boundingBox();
    await page.mouse.click(44, (search!.y + search!.height + settings!.y) / 2);
    await expect(rail).not.toHaveClass(/is-collapsed/);

    // Each title is its section's door: every thread, and the full map.
    await page.getByRole("button", { name: "Recent threads, see all" }).click();
    await expect(page.locator(".settings-nav-item.is-active")).toHaveText("Chats");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("link", { name: "Memory, open the map" }).click();
    await expect(page).toHaveURL(/\/memory\/graph$/);
  } finally {
    threads = [];
  }
});

test("the Dashboard's card names pages only once a domain's name zooms it in", async ({ page }) => {
  await page.goto(`${origin}/`);
  const graph = page.locator(".dashboard-memory .kb-graph");
  await expect.poll(async () => (await graphCanvas(page).getAttribute("data-domains")) ?? "[]").toContain('"alpha"');
  expect(await pageNames(page)).toEqual([]);

  await pressDomainName(page, "alpha");
  await expect(graph).toHaveAttribute("data-focus", "alpha");
  await expect.poll(() => pageNames(page)).toContain("Alpha Concept");
  expect(await pageNames(page)).not.toContain("Beta Source");

  // The fit zooms back out and the names go with it.
  await page.getByRole("button", { name: "Show every domain" }).click();
  await expect(graph).not.toHaveAttribute("data-focus");
  await expect.poll(() => pageNames(page)).toEqual([]);

  // Pressing the focused domain's name again zooms out too.
  await pressDomainName(page, "beta");
  await expect(graph).toHaveAttribute("data-focus", "beta");
  await expect.poll(() => pageNames(page)).toContain("Beta Source");
  await pressDomainName(page, "beta");
  await expect(graph).not.toHaveAttribute("data-focus");
  await expect.poll(() => pageNames(page)).toEqual([]);
  await expect(page).toHaveURL(`${origin}/`);
});

/** A queue row as the maintenance route reports it. */
function queueJob(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, kind: "document", marker: `paper:${id}`, payload: { paperId: id }, status: "pending", attempts: 0,
    leaseExpiresAt: null, retryAt: null, lastError: null, createdAt: now, updatedAt: now,
    label: "Pending paper", context: "Filing a document",
    failure: null as { cause: string; failedAt: string; pages: Array<{ title: string; reason: string }> } | null, ...overrides,
  };
}
function snapshot(jobs: Array<ReturnType<typeof queueJob>>, cancellable = 0) {
  return {
    pending: jobs.filter((job) => job.status === "pending").length,
    leased: 0, cancellable, failed: jobs.filter((job) => job.status === "failed").length, due: 0, jobs, maxAttempts: 3,
  };
}
/** Health's rail foot: one status, or nothing. */
function railFoot(page: Page) {
  return page.locator(".kb-memory-rail .kb-health-status");
}

test("a healthy Memory leaves the rail's foot empty, and the activity says what it has", async ({ page }) => {
  await page.goto(`${origin}/memory/health`);
  await viewSelected(page, "Health");
  await expect(page.getByText("Nothing has been filed yet.", { exact: true })).toBeVisible();
  await expect(railFoot(page)).toHaveCount(0);
  // A new account's empty activity starts where its label does, in the summary's type.
  const empty = page.getByText("Nothing has been filed yet.", { exact: true });
  const [label, line, inset] = await Promise.all([
    page.locator(".kb-activity-head .kb-memory-label").boundingBox(),
    empty.boundingBox(),
    empty.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft)),
  ]);
  expect(Math.abs(label!.x - (line!.x + inset))).toBeLessThan(1);
  await expect(empty).toHaveCSS("font-size", "11.5px");
});

test("waiting documents are one File press, which files exactly those and turns into Filing with a stop", async ({ page }) => {
  // One document waits; one is filed and current.
  const papers = [candidate, { ...candidate, paperId: "current", title: "Current paper", filed: true, filedVersion: "1" }];
  let jobs: Array<ReturnType<typeof queueJob>> = [];
  let cancellable = 0;
  const filed: string[] = [];
  let cancelled = 0;
  await page.route("**/api/memory/backfill/papers", async (route) => {
    if (route.request().method() === "POST") {
      filed.push(route.request().postData() ?? "");
      jobs = [queueJob("paper")];
      cancellable = 1;
      await route.fulfill({ json: { queued: 1 } });
    } else {
      await route.fulfill({ json: { papers } });
    }
  });
  await page.route("**/api/memory/maintenance", (route) => route.fulfill({ json: snapshot(jobs, cancellable) }));
  await page.route("**/api/memory/maintenance/cancel", (route) => {
    cancelled += 1;
    jobs = [];
    cancellable = 0;
    return route.fulfill({ json: { cancelled: 1 } });
  });
  await page.goto(`${origin}/memory/health`);

  const file = railFoot(page).getByRole("button", { name: "File 1 document", exact: true });
  await expect(file).toBeVisible();
  await expect(file).toContainText("File");
  await expect(file.locator(".kb-health-status-number")).toHaveText("1");
  await expect(file).toHaveCSS("background-color", "rgb(90, 38, 32)");
  await expect(file).toHaveCSS("border-radius", "8px");
  await file.click();
  await expect.poll(() => filed).toEqual([JSON.stringify({ paperIds: ["paper"] })]);

  // Filing has no panel: it says how much is left, and its stop sits on it.
  const filing = railFoot(page).getByRole("status");
  await expect(filing).toContainText("Filing");
  await expect(filing.locator(".kb-health-count")).toHaveText("1");
  await expect(filing).toHaveAttribute("title", "1 left to file");
  await expect(railFoot(page).getByRole("button", { name: "File 1 document" })).toHaveCount(0);
  const stop = railFoot(page).getByRole("button", { name: "Stop filing", exact: true });
  await expect(stop).toHaveAttribute("title", "Stop filing · 1 left");
  await stop.click();
  await expect.poll(() => cancelled).toBe(1);
  // Nothing left to file, nothing wrong: the foot gets out of the way. The
  // stopped document is offered again, as File.
  await expect(railFoot(page).getByRole("status")).toHaveCount(0);
  await expect(railFoot(page).getByRole("button", { name: "File 1 document", exact: true })).toBeVisible();
});

test("a count that cannot be read says nothing while it loads, then offers File all", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const filed: Array<string | null> = [];
  await page.route("**/api/memory/backfill/papers", async (route) => {
    if (route.request().method() === "POST") {
      filed.push(route.request().postData());
      await route.fulfill({ json: { queued: 1 } });
    } else {
      await pending;
      await route.fulfill({ status: 503, json: { detail: "Backlog unavailable" } });
    }
  });
  await page.goto(`${origin}/memory/health`);
  try {
    await expect(page.getByText("Nothing has been filed yet.", { exact: true })).toBeVisible();
    await expect(railFoot(page)).toHaveCount(0);
  } finally {
    release();
  }
  const fileAll = railFoot(page).getByRole("button", { name: "File all waiting documents", exact: true });
  await expect(fileAll).toContainText("File all");
  await expect(fileAll).toHaveAttribute("title", /couldn’t be counted/);
  await fileAll.click();
  // No list was counted, so the server decides what is owed.
  await expect.poll(() => filed).toEqual([null]);
});

test("Memory unhealthy opens only what went wrong, and each list carries its own fix", async ({ page }) => {
  const gaveUpJob = queueJob("stuck", {
    label: "Stuck paper", status: "failed", attempts: 3, lastError: "The domain page could not be composed: the page body would be 9,154 characters, and a page is about 6,000.",
    failure: { cause: "answer", failedAt: now, pages: [] },
  });
  // Still retrying on its own: filing, never stuck.
  const backingOff = queueJob("other", { status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", lastError: "Rate limit", failure: { cause: "provider", failedAt: now, pages: [] } });
  let retried = false;
  const refiled: string[] = [];
  await page.route("**/api/memory/maintenance/jobs/stuck/retry", (route) => {
    retried = true;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/memory/maintenance", (route) => route.fulfill({ json: retried
    ? snapshot([queueJob("stuck", { label: "Stuck paper" }), backingOff], 2)
    : snapshot([gaveUpJob, backingOff], 1) }));
  // The fixtures' day, so "Filed today" and "last try today" read as written.
  await page.clock.setFixedTime(new Date(now));
  await page.route("**/api/memory/health", (route) => route.fulfill({ json: {
    pages: 3, computedAt: now, orphans: [], uncapturedFigures: [],
    droppedTargets: [
      { slug: "alpha-concept", title: "Alpha Concept", action: "edit", reason: "Unsupported claim", quote: "Alpha always holds.", marker: "m", paperId: "paper", filedAt: now },
      // The job that gave up left this one; Stuck already lists that document.
      { slug: "beta", title: "Beta", action: "edit", reason: "Too long", quote: "", marker: "m2", paperId: "stuck", filedAt: now },
    ],
    lastCheck: { kind: "lint", createdAt: now, summary: "", contradictions: [
      { pages: ["alpha", "alpha-concept"], claim: "Alpha disagrees", detail: "The two pages differ.",
        quotes: [{ page: "alpha", quote: "Alpha is one thing." }, { page: "alpha-concept", quote: "Alpha is another." }] },
    ] },
  } }));
  await page.route("**/api/memory/backfill/papers", async (route) => {
    if (route.request().method() === "POST") {
      refiled.push(route.request().postData() ?? "");
      await route.fulfill({ json: { queued: 1 } });
    } else {
      await route.fulfill({ json: {
        papers: [
          { ...candidate, filed: true, filedVersion: "1", dropped: [{ slug: "alpha-concept", title: "Alpha Concept", reason: "Unsupported claim" }] },
          { ...candidate, paperId: "stuck", title: "Stuck paper", filed: true, filedVersion: "1", dropped: [{ slug: "beta", title: "Beta", reason: "Too long" }] },
        ],
      } });
    }
  });
  await page.goto(`${origin}/memory/health`);

  const status = railFoot(page).getByRole("button", { name: "Memory unhealthy", exact: true });
  await expect(status).toBeVisible();
  // The delete button's red, a step brighter, with the alert mark.
  await expect(status).toHaveCSS("background-color", "rgb(196, 72, 60)");
  await expect(status.locator("img")).toHaveAttribute("src", /delphi-warning-alert\.gif$/);
  await expect(status).toHaveAttribute("aria-expanded", "false");
  await status.click();
  await expect(status).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("region", { name: "Why Memory is unhealthy" });
  // One row per thing that went wrong. Two jobs failed, but only one gave up.
  const rows = panel.locator(".kb-health-status-row");
  await expect(rows).toHaveText(["Stuck1", "Pages not written1", "Contradictions1"]);
  // The panel sits above the status, and the one still retrying is filing.
  const [panelBox, statusBox] = await Promise.all([panel.boundingBox(), status.boundingBox()]);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(statusBox!.y);
  await expect(panel.locator(".kb-health-status-foot")).toContainText("Filing1");
  await expect(panel.getByRole("button", { name: "Stop filing", exact: true })).toBeVisible();
  // Escape and a press elsewhere put it away, as any menu.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await status.click();
  await page.locator(".kb-memory-main").click({ position: { x: 600, y: 600 } });
  await expect(panel).toHaveCount(0);
  await expect(status).toHaveAttribute("aria-expanded", "false");
  await status.click();

  // Not written: the document, when it was filed, its page and why, and Try again.
  const dropped = panel.getByRole("button", { name: /^Pages not written/ });
  await dropped.click();
  await expect(dropped).toHaveAttribute("aria-expanded", "true");
  const notWritten = page.getByRole("region", { name: "Not written" });
  await expect(notWritten).toContainText("1 page from 1 document");
  await expect(notWritten).toContainText("Pending paper");
  await expect(notWritten).toContainText("Filed today · 1 page not written");
  await expect(notWritten).toContainText("Unsupported claim");
  await expect(notWritten.locator("q")).toHaveText("Alpha always holds.");
  await notWritten.getByRole("button", { name: "Try again: Pending paper", exact: true }).click();
  await expect.poll(() => refiled).toEqual([JSON.stringify({ paperIds: ["paper"] })]);

  // One list at a time; the panel stays open over it.
  const disagree = panel.getByRole("button", { name: /^Contradictions/ });
  await disagree.click();
  await expect(dropped).toHaveAttribute("aria-expanded", "false");
  await expect(notWritten).toHaveCount(0);
  const contradictions = page.getByRole("region", { name: "Contradictions" });
  await expect(contradictions).toContainText("1 found by the health check today");
  await expect(contradictions).toContainText("Alpha disagrees");
  // The two pages side by side, each with what it says.
  const sides = contradictions.locator(".kb-health-side");
  await expect(sides).toHaveCount(2);
  await expect(sides.nth(0)).toContainText("alpha, as first written");
  await expect(sides.nth(0)).toContainText("Alpha is one thing.");
  await expect(sides.nth(1)).toContainText("Alpha Concept");
  await expect(sides.nth(1)).toContainText("Alpha is another.");
  const [left, right] = await Promise.all([sides.nth(0).boundingBox(), sides.nth(1).boundingBox()]);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(1);
  await contradictions.getByRole("button", { name: "Close this list", exact: true }).click();
  await expect(contradictions).toHaveCount(0);
  await expect(disagree).toHaveAttribute("aria-expanded", "false");

  // A list left open closes when Health is left, rather than greeting the return.
  await disagree.click();
  await expect(contradictions).toBeVisible();
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await viewSelected(page, "Map");
  await page.getByRole("tab", { name: "Health", exact: true }).click();
  await viewSelected(page, "Health");
  await expect(page.locator(".kb-health-list")).toHaveCount(0);

  // Stuck: what gave up, how hard it tried, why in words, the raw detail one press away.
  await railFoot(page).getByRole("button", { name: "Memory unhealthy", exact: true }).click();
  const stuckRow = page.getByRole("region", { name: "Why Memory is unhealthy" }).getByRole("button", { name: /^Stuck/ });
  await stuckRow.click();
  await expect(stuckRow).toHaveAttribute("aria-controls", "kb-health-stuck");
  const stuck = page.locator("#kb-health-stuck");
  await expect(stuck).toContainText("1 job gave up");
  await expect(stuck).toContainText("Stuck paper");
  await expect(stuck).toContainText(/Gave up after 3 tries · last try/);
  await expect(stuck).toContainText("Unusable answer. The model’s reply came back cut off or garbled.");
  // Only what gave up: the job backing off is not listed.
  await expect(stuck.locator(".kb-health-row")).toHaveCount(1);
  const detail = stuck.getByRole("button", { name: "Technical detail", exact: true });
  await detail.click();
  await expect(stuck.locator(".kb-health-detail")).toContainText("could not be composed");
  expect(await stuck.locator(".kb-health-detail").evaluate((node) => getComputedStyle(node).fontFamily)).not.toMatch(/mono/i);
  await expect(stuck.getByRole("button", { name: "Hide the technical detail", exact: true })).toBeVisible();
  const retry = stuck.getByRole("button", { name: "Try again: Stuck paper", exact: true });
  await expect(retry).toHaveCSS("border-radius", "6px");
  await retry.click();
  await expect.poll(() => retried).toBe(true);
  // Once nothing is stuck its row goes, and the list with it.
  await expect(page.locator("#kb-health-stuck")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Why Memory is unhealthy" }).locator(".kb-health-status-row")).toHaveText(["Pages not written1", "Contradictions1"]);
});

/** A document job that stopped trying, with the cause the server named. */
function gaveUp(id: string, label: string, cause: string | null, extra: Record<string, unknown> = {}) {
  return queueJob(id, {
    label, status: "failed", attempts: 3, lastError: `${cause ?? "Odd"} error for ${label}`,
    failure: cause ? { cause, failedAt: now, pages: [] } : null, ...extra,
  });
}

/** The account's queue, as the card reads it, and every retry the card asks for. */
async function serveQueue(page: Page, jobs: Array<ReturnType<typeof queueJob>>) {
  const state = { jobs, retried: [] as string[] };
  const cancellable = () => state.jobs.filter((job) => job.status !== "failed" || job.retryAt).length;
  await page.route("**/api/memory/maintenance", (route) => route.fulfill({ json: snapshot(state.jobs, cancellable()) }));
  await page.route("**/api/memory/maintenance/jobs/*/retry", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    state.retried.push(id);
    state.jobs = state.jobs.map((job) => job.id === id ? { ...job, status: "pending", attempts: 0, failure: null } : job);
    return route.fulfill({ json: {} });
  });
  return state;
}

const runCard = (page: Page) => page.locator(".kb-operation-notice-layer .kb-backfill");

test("a run's failures read one cause at a time, and each cause's verb fixes its own documents", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const state = await serveQueue(page, [
    gaveUp("check-1", "Muon notes", "check", { failure: { cause: "check", failedAt: now, pages: [
      { title: "Muon optimizer", reason: "The update rule it states is not in the passage it cites." },
      { title: "Newton–Schulz iteration", reason: "Cites a figure the document does not have." },
    ] } }),
    gaveUp("check-2", "Adam variants", "check", { failure: { cause: "check", failedAt: now, pages: [{ title: "AdamW", reason: "No passage says this." }] } }),
    gaveUp("busy", "Scaling laws", "provider", { lastError: "Client error '429 Too Many Requests' for url 'https://api.openai.com/v1/responses'" }),
    gaveUp("key", "Flash attention", "signin"),
    gaveUp("gone", "Lost scan", "document", { payload: { paperId: "paper-gone", projectId: "project-1" } }),
    gaveUp("odd", "Strange paper", null, { lastError: "KeyError: 'figures'" }),
    queueJob("later", { label: "Ring attention", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", failure: { cause: "provider", failedAt: now, pages: [] } }),
  ]);
  await page.route("**/desktop/connection", (route) => route.fulfill({ json: {
    connection: "openai-api", keys: { openai: true, claude: false }, chatgpt: { connected: false }, claude: { connected: false },
  } }));
  await page.route("**/api/projects/project-1", (route) => route.fulfill({ json: {
    id: "project-1", slug: "reading", name: "Reading", papers: [{ id: "paper-gone", slug: "lost-scan", title: "Lost scan" }],
  } }));
  await page.goto(`${origin}/memory/health`);

  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("6 documents failed");
  await expect(card.locator(".kb-backfill-detail")).toHaveText("1 retrying. Your Memory was not changed.");
  await expect(card.locator(".notice-mark img")).toHaveAttribute("src", /delphi-warning-alert\.gif$/);
  // Failures are listed open, a cause to a row, never a column per cause.
  const fold = card.getByRole("button", { name: /^Failed/ });
  await expect(fold).toHaveText(/Failed\s*6 documents/);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const groups = card.locator(".kb-run-group");
  await expect(groups.locator(".kb-run-group-title")).toHaveText([
    "Failed the source check2", "Provider unavailable1", "Sign-in refused1", "Document unreadable1", "Unknown error1", "Retrying soon1",
  ]);
  const titles = await groups.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
  expect(new Set(titles).size).toBe(1);

  // The source check names the pages it refused, and why.
  const check = card.getByRole("region", { name: "Failed the source check" });
  await expect(check.locator(".kb-run-group-line")).toHaveText("No page was written.");
  const refused = check.getByRole("list", { name: "Pages not written" }).first();
  await expect(refused.locator(".kb-health-row-name")).toHaveText(["Muon optimizer", "Newton–Schulz iteration"]);
  await expect(refused).toContainText("Cites a figure the document does not have.");
  // Two documents: each has its own verb, shown as the pointer reaches it.
  const own = check.getByRole("button", { name: "Try again: Adam variants", exact: true });
  await expect(own).toHaveCSS("opacity", "0");
  await check.locator(".kb-run-document").nth(1).hover();
  await expect(own).toHaveCSS("opacity", "1");
  // One document: the cause's verb is the only one.
  const busy = card.getByRole("region", { name: "Provider unavailable" });
  await expect(busy.locator(".kb-run-document-verb")).toHaveCount(0);
  await expect(busy.locator(".kb-run-group-line")).toHaveText("Busy, down or past your plan’s limit.");

  // A cause unknown says so, and what the error said is one press away.
  const odd = card.getByRole("region", { name: "Unknown error" });
  await expect(odd.locator(".kb-health-detail")).toHaveCount(0);
  await odd.getByRole("button", { name: "Technical detail", exact: true }).click();
  await expect(odd.locator(".kb-health-detail")).toHaveText("KeyError: 'figures'");

  // Still retrying is not a failure: last, with nothing to do but wait.
  const later = card.getByRole("region", { name: "Retrying soon" });
  await expect(later).toContainText("Ring attention");
  await expect(later.locator(".kb-run-next")).toHaveText(/^Next try \d\d:\d\d · try 2 of 3$/);
  await expect(later.getByRole("button")).toHaveCount(0);

  // What can be tried again spans causes, so the head offers it all at once.
  await expect(card.getByRole("button", { name: "Try all 4", exact: true })).toHaveClass(/primary-button/);
  // The cause's own verb retries only its documents, and the card follows them.
  await check.getByRole("button", { name: "Try again: Failed the source check", exact: true }).click();
  await expect.poll(() => state.retried).toEqual(["check-1", "check-2"]);
  await expect(card.getByRole("region", { name: "Failed the source check" })).toHaveCount(0);
  await expect(card.locator(".kb-backfill-title")).toHaveText("Updating your Memory");
  await expect(card.getByRole("button", { name: /^Try all/ })).toHaveCount(0);
  // Sign-in and an unreadable document are fixed elsewhere.
  await card.getByRole("region", { name: "Sign-in refused" }).getByRole("button", { name: "Open AI connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  // Working in Settings was looking away: the run waits as one line.
  await page.locator(".kb-notice-pill").filter({ hasText: "Updating your Memory" }).click();
  await card.getByRole("region", { name: "Document unreadable" }).getByRole("button", { name: "Open Lost scan", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/@reader/reading/lost-scan`);
});

test("Try all retries what gave up across causes, and the card follows the run it starts", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const state = await serveQueue(page, [
    gaveUp("busy", "Scaling laws", "provider"),
    gaveUp("cut", "Long survey", "answer"),
    gaveUp("key", "Flash attention", "signin"),
  ]);
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("3 documents failed");
  // A sign-in refused is not tried again: no try would pass.
  await card.getByRole("button", { name: "Try all 2", exact: true }).click();
  await expect.poll(() => [...state.retried].sort()).toEqual(["busy", "cut"]);
  // Two documents back in line: the card is a run again, with nothing left to try all.
  await expect(card.locator(".kb-backfill-title")).toHaveText("Updating your Memory");
  await expect(card.getByRole("button", { name: /^Try all/ })).toHaveCount(0);
  await expect(card.getByRole("region", { name: "Sign-in refused" })).toBeVisible();
});

test("a long cause shows three and the rest on request, and the card shrinks to its count", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const titles = ["One", "Two", "Three", "Four", "Five"];
  const state = await serveQueue(page, titles.map((title) => gaveUp(title.toLowerCase(), title, "provider")));
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  const busy = card.getByRole("region", { name: "Provider unavailable" });
  await expect(busy.locator(".kb-run-document strong")).toHaveText(["One", "Two", "Three"]);
  await busy.getByRole("button", { name: "2 more", exact: true }).click();
  await expect(busy.locator(".kb-run-document strong")).toHaveText(titles);
  await busy.getByRole("button", { name: "Show fewer", exact: true }).click();
  await expect(busy.locator(".kb-run-document strong")).toHaveCount(3);
  // One cause: its own verb says what Try all would.
  await expect(card.getByRole("button", { name: /^Try all/ })).toHaveCount(0);

  // The list folds away, and looking elsewhere shrinks the card to its count.
  await card.getByRole("button", { name: /^Failed/ }).click();
  await expect(card.locator(".kb-run-groups")).toHaveCount(0);
  await page.locator(".kb-memory-main").click({ position: { x: 600, y: 600 } });
  const pill = page.locator(".kb-notice-pill");
  await expect(pill.locator("strong")).toHaveText("5 failed");
  await pill.click();
  await card.getByRole("region", { name: "Provider unavailable" })
    .getByRole("button", { name: "Try again: Provider unavailable", exact: true }).click();
  await expect.poll(() => state.retried).toEqual(["one", "two", "three", "four", "five"]);
});

test("documents only retrying are a run still going, and a dismissed failure stays read until it fails again", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const state = await serveQueue(page, [
    queueJob("later", { label: "Ring attention", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", failure: { cause: "provider", failedAt: now, pages: [] } }),
  ]);
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("Updating your Memory");
  await expect(card.locator(".kb-backfill-detail")).toHaveText("0 of 1 documents finished · 1 retrying.");
  await expect(card.getByRole("button", { name: /^Retrying/ })).toHaveText(/Retrying\s*1 document/);
  // Waiting out a retry can still be stopped, but not thrown away.
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Shrink update notice", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Dismiss update result", exact: true })).toHaveCount(0);

  // Health reads the queue each time it opens.
  const reread = async () => {
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/memory/maintenance");
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await page.getByRole("tab", { name: "Health", exact: true }).click();
    await read;
  };
  // It gives up. Pressing the tabs shrank the card, so it says so in a word.
  const pill = page.locator(".kb-notice-pill");
  const failedAt = (at: string, updatedAt = at) =>
    [gaveUp("later", "Ring attention", "provider", { updatedAt, failure: { cause: "provider", failedAt: at, pages: [] } })];
  state.jobs = failedAt("2026-09-30T12:06:00Z");
  await reread();
  await expect(pill.locator("strong")).toHaveText("1 failed");
  await pill.click();
  await expect(card.locator(".kb-backfill-title")).toHaveText("1 document failed");
  await card.getByRole("button", { name: "Dismiss update result", exact: true }).click();
  await expect(card).toHaveCount(0);
  // Read again, it stays put away, even once the row moves on for another
  // reason (a re-enqueue touches it). Failing again is news.
  await reread();
  await expect(card).toHaveCount(0);
  state.jobs = failedAt("2026-09-30T12:06:00Z", "2026-09-30T12:20:00Z");
  await reread();
  await expect(card).toHaveCount(0);
  await expect(pill).toHaveCount(0);
  state.jobs = failedAt("2026-09-30T12:40:00Z");
  await reread();
  await expect(card.locator(".kb-backfill-title")).toHaveText("1 document failed");
});

test("a sign-in still retrying waits under its cause, beside the fix, not as nothing to do", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  await serveQueue(page, [
    queueJob("key", { label: "Flash attention", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", failure: { cause: "signin", failedAt: now, pages: [] } }),
    queueJob("busy", { label: "Scaling laws", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", failure: { cause: "provider", failedAt: now, pages: [] } }),
  ]);
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("Updating your Memory");
  await expect(card.locator(".kb-run-group-title")).toHaveText(["Sign-in refused1", "Retrying soon1"]);
  const signin = card.getByRole("region", { name: "Sign-in refused" });
  await expect(signin).toContainText("Flash attention");
  await expect(signin.locator(".kb-run-next")).toHaveText(/^Next try \d\d:\d\d · try 2 of 3$/);
  await expect(signin.getByRole("button", { name: "Open AI connection", exact: true })).toBeVisible();
  await expect(card.getByRole("region", { name: "Retrying soon" })).toContainText("Scaling laws");
});

test("while a retry runs only retries wait: the AI connection and a document still open", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const state = await serveQueue(page, [
    gaveUp("busy", "Scaling laws", "provider"),
    gaveUp("busy-2", "Chinchilla", "provider"),
    queueJob("key", { label: "Flash attention", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", failure: { cause: "signin", failedAt: now, pages: [] } }),
    queueJob("gone", { label: "Scanned notes", status: "failed", attempts: 1, retryAt: "2026-09-30T12:05:00Z", payload: { paperId: "paper-gone", projectId: "project-1" }, failure: { cause: "document", failedAt: now, pages: [] } }),
  ]);
  await page.route("**/desktop/connection", (route) => route.fulfill({ json: {
    connection: "openai-api", keys: { openai: true, claude: false }, chatgpt: { connected: false }, claude: { connected: false },
  } }));
  // The run a retry starts holds the drain until it ends.
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/memory/maintenance/drain", async (route) => {
    await held;
    await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: 'data: {"type":"done","claimed":false}\n\n' });
  });
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  const provider = card.getByRole("region", { name: "Provider unavailable" });
  await provider.getByRole("button", { name: "Try again: Scaling laws", exact: true }).click();
  await expect.poll(() => state.retried).toEqual(["busy"]);
  await expect(provider.getByRole("button", { name: "Try again: Provider unavailable", exact: true })).toBeDisabled();

  // A document still retrying on a cause only the reader can fix carries that fix.
  const unreadable = card.getByRole("region", { name: "Document unreadable" });
  await expect(unreadable.locator(".kb-run-next")).toHaveText(/^Next try \d\d:\d\d · try 2 of 3$/);
  await expect(unreadable.getByRole("button", { name: "Open Scanned notes", exact: true })).toBeEnabled();
  await card.getByRole("region", { name: "Sign-in refused" }).getByRole("button", { name: "Open AI connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
  finish();
});

test("Try again over a document another tab already revived reports nothing, and reads the queue again", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const state = await serveQueue(page, [gaveUp("busy", "Scaling laws", "provider"), gaveUp("cut", "Long survey", "answer")]);
  await page.goto(`${origin}/memory/health`);
  const card = runCard(page);
  await expect(card.locator(".kb-backfill-title")).toHaveText("2 documents failed");
  // The other tab got there first: the row is pending, and the retry is refused.
  state.jobs = state.jobs.map((job) => job.id === "busy" ? { ...job, status: "pending", attempts: 0, failure: null } : job);
  await page.route("**/api/memory/maintenance/jobs/busy/retry", (route) =>
    route.fulfill({ status: 409, json: { detail: "Only a failed job can be retried" } }));
  await card.getByRole("region", { name: "Provider unavailable" })
    .getByRole("button", { name: "Try again: Provider unavailable", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card.locator(".kb-backfill-title")).toHaveText("Updating your Memory");
  await expect(card.getByRole("region", { name: "Provider unavailable" })).toHaveCount(0);
  await expect(card.getByRole("region", { name: "Unusable answer" })).toBeVisible();
});

test("a health check that did not finish says so in the pane, and a missing AI connection goes straight to it", async ({ page }) => {
  let answer: "fail" | "no-provider" = "fail";
  let release!: () => void;
  let requested = 0;
  await page.route("**/api/memory/reorganize/stream", (route) => route.fulfill({
    headers: { "content-type": "text/event-stream" },
    body: 'data: {"type":"done","moves":[],"domains":[],"method":"model"}\n\n',
  }));
  await page.route("**/api/memory/lint", async (route) => {
    const held = new Promise<void>((resolve) => { release = resolve; });
    requested += 1;
    await held;
    await route.fulfill(answer === "fail"
      ? { headers: { "content-type": "text/event-stream" }, body: 'data: {"type":"error","message":"Lint pass failed: HTTP 524"}\n\n' }
      : { status: 503, json: { detail: "No provider" } });
  });
  // Set up for API keys with none saved: the sheet must open on that, though it
  // mounts before the connection has been read.
  await page.route("**/desktop/connection", (route) => route.fulfill({ json: {
    connection: "openai-api", keys: { openai: false, claude: false }, chatgpt: { connected: false }, claude: { connected: false },
  } }));
  await page.goto(`${origin}/memory/health`);
  // The placement review that runs beside each check finds nothing to move, and
  // its notice floats over the pane until closed, as a reader would close it.
  const misfiled = page.locator(".kb-update-banner").filter({ hasText: "Nothing looks misfiled." });
  await page.addLocatorHandler(misfiled, () => misfiled.getByRole("button", { name: "Close", exact: true }).click());

  // While it runs, the check's own button says so.
  await page.getByRole("button", { name: "Run health check", exact: true }).click();
  const checking = page.getByRole("button", { name: "Checking…", exact: true });
  await expect(checking).toBeDisabled();
  await expect(checking.locator(".kb-health-live")).toBeVisible();
  await expect.poll(() => requested).toBe(1);
  release();

  const failure = page.getByRole("alert").filter({ hasText: "The health check didn’t finish" });
  await expect(failure).toContainText("Your Memory wasn’t changed.");
  await expect(failure.locator(".kb-health-detail")).toHaveCount(0);
  await failure.getByRole("button", { name: "Technical detail", exact: true }).click();
  await expect(failure.locator(".kb-health-detail")).toHaveText("Lint pass failed: HTTP 524");

  answer = "no-provider";
  await failure.getByRole("button", { name: "Run it again", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await expect.poll(() => requested).toBe(2);
  release();
  const connect = page.getByRole("alert").filter({ hasText: "Checking for contradictions needs an AI connection" });
  await expect(connect).toContainText("The live counts still work.");
  await connect.getByRole("button", { name: "Open AI connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
  const kind = page.getByRole("navigation", { name: "Connection type" });
  await expect(kind.getByRole("button", { name: /API keys/ })).toHaveAttribute("aria-current", "page");
});

test("the activity log ends in real verbs: more edits, and a way back from a filter that found nothing", async ({ page }) => {
  // Twenty created pages, one pass each: more than the log shows at once.
  const events = Array.from({ length: 20 }, (_, index) => ({
    kind: "ingest", createdAt: new Date(Date.parse(now) - index * 60_000).toISOString(), summary: "Filed a document.",
    edits: [{ slug: `page-${index}`, title: `Page ${index}`, kind: "concept", action: "created", note: null }],
  }));
  await page.route("**/api/memory", (route) => route.fulfill({ json: { ...overview, events } }));
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/memory/health`);
  const more = page.getByRole("button", { name: "Show 6 earlier edits", exact: true });
  await expect(more).toHaveCSS("border-radius", "6px");
  await more.click();
  await expect(more).toHaveCount(0);
  await expect(page.locator(".kb-activity-row")).toHaveCount(20);

  await page.getByRole("radio", { name: "Revised", exact: true }).click();
  await expect(page.getByText("No pages were revised.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show all edits", exact: true }).click();
  await expect(page.getByRole("radio", { name: "All", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".kb-activity-row")).toHaveCount(20);
});

for (const provider of ["chatgpt", "claude"] as const) for (const connected of [false, true]) {
  test(`AI connection status for ${provider} reflects a ${connected ? "usable" : "rejected"} subscription catalog`, async ({ page }) => {
    const message = "The subscription is unavailable.";
    let percentLeft = 99;
    await page.route("**/desktop/connection", route => route.fulfill({ json: {
      connection: provider === "claude" ? "claude-subscription" : "chatgpt-oauth", keys: { openai: false, claude: false },
      [provider]: { connected, ...(connected ? { usage: { plan: "Plus", percentLeft, weekly: true, resets: "Oct 24" } } : { message }) },
    } }));
    await page.goto(origin);
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const row = page.locator(".settings-connection-row");
    await expect(row.locator(".settings-status-chip")).toHaveText(connected ? "Connected" : "Needs attention");
    await expect(row).toContainText(connected ? "Plus plan · 99% of weekly usage left, resets Oct 24" : message);
    if (connected) {
      await expect(row.locator("small strong")).toHaveText("99%");
      await row.getByRole("button", { name: "Change", exact: true }).click();
      await expect(page.locator(".settings-connection-status")).toContainText("99% of weekly usage left, resets Oct 24");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      percentLeft = 87;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Advanced", exact: true }).click();
      await expect(page.locator(".settings-connection-row")).toContainText("87% of weekly usage left");
    }
  });
}

test("effort bars increase from Low to Max for each model", async ({ page }) => {
  await page.goto(`${origin}/memory/graph`);
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  for (const model of ["GPT-6 Luna", "GPT-6.1 Sol"]) {
    await page.getByRole("button", { name: /^Model:/ }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(model) }).click();
    const choices = page.locator('.model-picker-submenu [role="menuitemradio"]');
    const labels = ["Low", "Medium", "High", "xHigh", "Max"];
    await expect(choices).toHaveCount(labels.length);
    for (const [index, label] of labels.entries()) {
      const choice = page.getByRole("menuitemradio", { name: label, exact: true });
      await expect(choice.locator(".effort-bars i.on")).toHaveCount(index + 1);
    }
    await page.getByRole("menuitemradio", { name: labels.at(-1)!, exact: true }).click();
    await expect(page.getByRole("button", { name: /^Model:/ })).toHaveAccessibleName(new RegExp(`${model}.*${labels.at(-1)}`, "i"));
  }
});

test("a long run on a Memory page wraps rather than widening the page", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept`);
  const prose = page.locator(".kb-prose");
  await expect(prose).toContainText("It was read at");
  const [scrolled, shown] = await prose.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  expect(scrolled).toBeLessThanOrEqual(shown);
});

test("an outside source opens over the whole window, in its own type", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept`);
  const openers = [
    () => page.locator(".kb-prose").getByRole("button", { name: "E1", exact: true }).click(),
    async () => {
      await page.locator(".kb-provenance-toggle").click();
      await page.getByRole("button", { name: "outside source", exact: true }).click();
    },
  ];
  for (const open of openers) {
    await open();
    const dialog = page.getByRole("dialog", { name: "Outside page" });
    await expect(dialog).toContainText("What the outside page said.");
    // Its backdrop covers the window, not the pane the page sits in.
    const viewport = page.viewportSize()!;
    expect(await dialog.evaluate((element) => element.parentElement!.getBoundingClientRect().toJSON()))
      .toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    // The passage reads at its own weight, not the citation marker's.
    await expect(dialog.getByText("What the outside page said.")).toHaveCSS("font-weight", "400");
    await page.getByRole("button", { name: "Close captured source" }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test("a Memory chat carried from a page to the map is not released on the way", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept&ask=1&conversation=${first.id}`);
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveAttribute("aria-selected", "true");
  releases.length = 0;
  await page.getByRole("button", { name: "Back to map" }).click();
  await expect(page).toHaveURL(`${origin}/memory/graph?domain=alpha&ask=1&conversation=${first.id}`);
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveAttribute("aria-selected", "true");
  // The chat docked beside the map is a new one; the reader never left the conversation.
  await page.waitForTimeout(1000);
  expect(releases).not.toContain(JSON.stringify({ conversationId: first.id }));
});

test("a large display widens Memory's conversation, and a laptop takes it back", async ({ page }) => {
  const column = () => page.locator("[style*='--kb-chat-width']").first()
    .evaluate((node) => parseFloat((node as HTMLElement).style.getPropertyValue("--kb-chat-width")));
  const open = () => page.goto(`${origin}/memory?page=alpha-concept&ask=1&conversation=${first.id}`);
  await page.setViewportSize({ width: 1512, height: 945 });
  await open();
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(column).toBe(460);

  await page.setViewportSize({ width: 2560, height: 1440 });
  await expect.poll(column).toBeGreaterThan(600);
  // Dragged as wide as it goes, then the window moves back to the laptop.
  await page.getByRole("separator", { name: "Resize the conversation" }).focus();
  await page.keyboard.press("End");
  await expect.poll(column).toBeGreaterThan(900);
  await page.setViewportSize({ width: 1512, height: 945 });
  // A laptop's ceiling, 10% past the 720px it opens well short of.
  await expect.poll(column).toBe(792);
  await page.setViewportSize({ width: 1180, height: 800 });
  // The page keeps the room it has had on a laptop since before large displays.
  await expect.poll(column).toBe(1180 - 520);
});

for (const [width, height] of [[1512, 945], [3440, 1440]] as const) {
  test(`an expanded chat takes most of a ${width}px window and centres its turns`, async ({ page }) => {
    const turn = (role: string, content: string) => ({ role, content, createdAt: now, requestId: "wide" });
    await page.route("**/api/chat?*", (route) => route.fulfill({ json: { images: [], messages: [
      turn("user", "Why does the step size matter?"),
      turn("assistant", "A long answer about step sizes. ".repeat(60)),
    ] } }));
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/memory?page=alpha-concept&ask=1&conversation=${first.id}`);
    await page.getByRole("button", { name: "Expand chat", exact: true }).click();
    // Each margin is 40% less than the old 60vw (to 980px, or half the window) by 78vh card left.
    const card = page.locator(".kb-chat-rail .kb-ask-modal");
    const size = () => card.evaluate((node) => { const rect = node.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)]; });
    const old = Math.max(Math.min(width * 0.6, 980), width * 0.5);
    await expect.poll(size).toEqual([Math.round(width * 0.4 + old * 0.6), Math.round(height * 0.868)]);
    const turns = page.locator(".kb-chat-rail .messages .message");
    await expect(turns).toHaveCount(2);
    for (const box of await turns.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement!;
      const style = getComputedStyle(parent);
      const inner = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const left = rect.left - parent.getBoundingClientRect().left - parseFloat(style.paddingLeft);
      return { width: rect.width, inner, left, right: inner - left - rect.width };
    }))) {
      // A laptop's turns fill the card; a wide display's stop at a measure and centre.
      expect(box.width).toBeCloseTo(Math.min(1240, box.inner), 0);
      expect(Math.abs(box.left - box.right)).toBeLessThan(2);
    }
  });
}

test("on a large display the Dashboard's sidebar slides its content without resizing it", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto(origin);
  const content = page.locator(".dashboard-wrap");
  const width = () => content.evaluate((node) => Math.round(node.getBoundingClientRect().width));
  const collapsed = await width();
  expect(collapsed).toBeGreaterThan(1320);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar", exact: true })).toBeVisible();
  expect(await width()).toBe(collapsed);
  await page.setViewportSize({ width: 1512, height: 945 });
  expect(await width()).toBeLessThanOrEqual(1320);
});

test("a Memory chat opened from Settings while the map is up docks beside it", async ({ page }) => {
  const openFromSettings = async (title: string) => {
    await page.getByRole("button", { name: "Search and settings" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).press("Enter");
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(title) }).click();
  };
  await page.goto(`${origin}/memory/graph?ask=1&conversation=${first.id}`);
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveAttribute("aria-selected", "true");

  // A chat begun since the map loaded, which the rail has not listed.
  memoryChats = [first, second];
  listedChats = [first, second];
  await openFromSettings("Second chat");
  await expect(page.getByRole("tab", { name: "Second chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(`${origin}/memory/graph?ask=1&conversation=${second.id}`);

  // One deleted since Settings listed it says so, and the chat on screen stays.
  listedChats = [first, second, chat("c".repeat(32), "Deleted chat")];
  await openFromSettings("Deleted chat");
  await expect(page.getByText("That conversation is no longer available.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Second chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(`${origin}/memory/graph?ask=1&conversation=${second.id}`);

  // With the chat window closed, the next link opens it again.
  await page.getByRole("button", { name: "Close Second chat" }).click();
  await page.getByRole("button", { name: "Close First chat" }).click();
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveCount(0);
  await expect(page).toHaveURL(`${origin}/memory/graph`);
  await openFromSettings("First chat");
  await expect(page.getByRole("tab", { name: "First chat" })).toHaveAttribute("aria-selected", "true");
});

test("a page that cites but has no source page still says where it comes from", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept`);
  const provenance = page.getByRole("region", { name: "Where this page comes from" });
  // Folded, it counts what it holds; open, the capture is a source of its own, with its passage.
  await provenance.getByRole("button", { name: "1 source", exact: true }).click();
  await expect(provenance.getByRole("button", { name: "outside source", exact: true })).toBeVisible();
  await expect(provenance.locator(".kb-provenance-section")).toHaveText(["§intro"]);
});

/** A page as a listing names it: what `backlinks` holds. */
function summaryOf({ id, slug, kind, domain, title, summary, tags, revision, createdAt, updatedAt, linkDegree }: MemoryPage): MemoryPageSummary {
  return { id, slug, kind, domain, title, summary, tags, revision, createdAt, updatedAt, linkDegree };
}

test("Provenance folds to a count per group, and a deleted source or author keeps its name, greyed", async ({ page }) => {
  const authored: MemoryPageDetail = {
    page: {
      ...memoryPage("authored", "alpha", "concept", "Authored"),
      body: "A claim [E1]. A claim the deleted document made [E2].",
      citations: [
        { id: 1, claimType: "author-claim", paperId: "paper", page: 2 },
        { id: 2, claimType: "author-claim", paperId: "gone", page: 3 },
      ],
    },
    sources: [
      { paperId: "paper", projectId: "project", title: "LLaDA", passages: 1, pages: [2], sections: [], available: true },
      { paperId: "gone", projectId: null, title: "dKV-Cache", passages: 1, pages: [3], sections: [], available: false },
    ],
    backlinks: [summaryOf(concept)],
    authors: [
      { kind: "document", id: "paper", projectId: "project", title: "LLaDA", firstAt: "2026-09-12T10:00:00Z", note: "Wrote it from §3.2.", removed: false },
      { kind: "document", id: "gone", projectId: null, title: "dKV-Cache", firstAt: "2026-09-20T10:00:00Z", note: "Caching goes stale.", removed: true },
      { kind: "chat", id: "c1", projectId: null, title: "Which tricks stack?", firstAt: "2026-09-25T10:00:00Z", note: null, removed: false },
    ],
  };
  await page.route("**/api/memory/pages/authored", (route) => route.fulfill({ json: authored }));
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/memory?page=authored`);
  const provenance = page.getByRole("region", { name: "Where this page comes from" });
  const strip = provenance.locator(".kb-provenance-toggle");
  await expect(strip).toHaveText("2 sources · 3 authors · 1 reference");
  await expect(strip).toHaveAttribute("title", "1 source and 1 author deleted");
  await strip.click();
  await expect(provenance.locator("h3")).toHaveText(["Sources", "Written by", "Referenced by"]);

  const [sources, writers] = [0, 1].map((index) => provenance.locator(".kb-provenance-entries").nth(index).locator(".kb-provenance-entry"));
  await expect(sources.locator(".kb-provenance-entry-name")).toHaveText(["LLaDA", "dKV-Cache"]);
  await expect(sources.nth(0).locator(".kb-provenance-section")).toHaveText(["p. 2"]);
  // The deleted document is named, greyed, says so on hover, and opens nothing; so are its markers.
  await expect(sources.nth(1).locator(".kb-provenance-entry-name")).toHaveAttribute("title", "Deleted");
  await expect(sources.nth(1).locator(".kb-provenance-marker")).toHaveClass(/is-removed/);
  await expect(sources.nth(1).locator("button, a")).toHaveCount(0);

  await expect(writers.locator(".kb-provenance-entry-name")).toHaveText(["LLaDA", "dKV-Cache", "Memory chat: Which tricks stack?"]);
  await expect(writers.locator("time")).toHaveText(["Sep 12", "Sep 20", "Sep 25"]);
  await expect(writers.nth(1)).toContainText("Caching goes stale.");
  await expect(provenance.getByRole("button", { name: "LLaDA", exact: true })).toHaveCount(2);
  await expect(provenance.getByRole("button", { name: "dKV-Cache", exact: true })).toHaveCount(0);
  await expect(writers.nth(1).locator(".kb-provenance-entry-name")).toHaveAttribute("title", "Deleted");
});

test("a concept page deletes from its own header and the reader lands on its domain's map", async ({ page }) => {
  const asked: string[] = [];
  await page.route("**/api/memory/pages/alpha-concept", (route) => {
    asked.push(route.request().method());
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    return route.fulfill({ json: { page: concept, sources: [], backlinks: [summaryOf(pages[0])] } });
  });
  await page.goto(`${origin}/memory?page=alpha-concept`);
  await page.locator(".kb-page-meta").getByRole("button", { name: "Delete page", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete page?" });
  await expect(dialog).toContainText("Alpha Concept");
  await expect(dialog).toContainText("Links to it on 1 page become plain words.");
  // The dim covers the window, not only the page panel it was opened from.
  const backdrop = page.locator("body > .modal-backdrop");
  await expect(backdrop).toHaveCount(1);
  const viewport = page.viewportSize()!;
  expect(await backdrop.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await dialog.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect.poll(() => asked.includes("DELETE")).toBe(true);
  await expect(page).toHaveURL(/\/memory\/graph\?domain=alpha/);
});

test("a docked chat that named the deleted page reads its name as words from then on", async ({ page }) => {
  let deleted = false;
  await page.route("**/api/memory/pages/alpha-concept", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted = true;
    return route.fulfill({ status: 204 });
  });
  const standing = () => (deleted ? pages.filter((entry) => entry.slug !== "alpha-concept") : pages);
  await page.route("**/api/memory", (route) => route.fulfill({ json: { ...overview, pages: standing().map(summaryOf) } }));
  await page.route("**/api/memory/pages", (route) => route.fulfill({ json: standing().map(summaryOf) }));
  await page.route("**/api/chat?**", (route) => route.fulfill({ json: { images: [], messages: [
    { role: "user", content: "What does this rest on?", createdAt: now, requestId: "r1" },
    { role: "assistant", content: "It rests on [[alpha-concept]].", createdAt: now, requestId: "r1" },
  ] } }));
  await page.goto(`${origin}/memory?page=alpha-concept&ask=1`);
  const turn = page.locator(".kb-chat-turn").last();
  await expect(turn.locator("a.kb-link")).toHaveText("Alpha Concept");

  await page.locator(".kb-page-meta").getByRole("button", { name: "Delete page", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete page?" }).getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(page).toHaveURL(/\/memory\/graph\?domain=alpha/);
  await expect(turn).toContainText("It rests on alpha concept.");
  await expect(turn.locator("a.kb-link")).toHaveCount(0);
});

test("a source page offers Delete page only once its document is gone", async ({ page }) => {
  const source = pages.find((entry) => entry.slug === "beta-source")!;
  let projectId: string | null = "proj";
  const asked: string[] = [];
  await page.route("**/api/memory/pages/beta-source", (route) => {
    asked.push(route.request().method());
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    return route.fulfill({ json: { page: source, sources: [], backlinks: [summaryOf(concept)], document: { paperId: "p1", projectId } } });
  });
  const meta = page.locator(".kb-page-meta");
  await page.goto(`${origin}/memory?page=beta-source`);
  await expect(meta.getByRole("button", { name: "Open document" })).toBeVisible();
  await expect(meta.getByRole("button", { name: /^Delete page/ })).toHaveCount(0);

  projectId = null;
  await page.reload();
  await meta.getByRole("button", { name: "Delete page (document removed)", exact: true }).click();
  await expect(meta.getByRole("button", { name: "Open document" })).toHaveCount(0);
  const dialog = page.getByRole("alertdialog", { name: "Delete page?" });
  await expect(dialog).toContainText("Beta Source");
  await expect(dialog).toContainText("Links to it on 1 page become plain words. Pages written from its document stay.");
  await dialog.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect.poll(() => asked.includes("DELETE")).toBe(true);
  await expect(page).toHaveURL(/\/memory\/graph\?domain=beta/);
});

test("a domain's page offers no Delete page", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha`);
  await expect(page.locator(".kb-page-meta")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Delete page/ })).toHaveCount(0);
});

test("a deleted page's row in the log says Deleted and opens nothing", async ({ page }) => {
  const events = [{
    kind: "delete", createdAt: now, summary: "Deleted Gone.", pages: [],
    edits: [{ slug: "gone", title: "Gone", kind: "concept" as const, action: "deleted" as const, note: null }],
  }];
  await page.route("**/api/memory", (route) => route.fulfill({ json: { ...overview, events } }));
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/memory/health`);
  const row = page.locator(".kb-activity-row").filter({ hasText: "Gone" });
  await expect(row.locator(".kb-log-badge")).toHaveText("Deleted");
  await expect(row).toHaveJSProperty("tagName", "P");
});

test("a marker that opens its source reads at its citation's size", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept`);
  await expect(page.locator(".kb-prose").getByRole("button", { name: "E1", exact: true })).toBeVisible();
  // "(E1)" is one citation: the marker inside it is not shrunk a second time.
  const [marker, citation] = await page.evaluate(() => {
    const element = document.querySelector(".kb-prose p button")!;
    return [getComputedStyle(element).fontSize, getComputedStyle(element.parentElement!).fontSize];
  });
  expect(marker).toBe(citation);
});

test("opening Ask keeps the page's markers as they are", async ({ page }) => {
  await page.goto(`${origin}/memory?page=alpha-concept`);
  const marker = page.locator(".kb-prose").getByRole("button", { name: "E1", exact: true });
  // Once the page and the page list are in: a page read again redraws its prose, as it should.
  await expect(page.locator(".kb-prose").getByRole("link", { name: "Beta Source" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => { (document.querySelector(".kb-prose p button") as HTMLElement).dataset.seen = "1"; });
  await page.getByRole("button", { name: "Ask Delphi", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // The prose was not drawn again, so the same marker is still there.
  await expect(marker).toHaveAttribute("data-seen", "1");
});

for (const [connection, name, subscribed] of [["claude-subscription", "Claude plan", true], ["chatgpt-oauth", "ChatGPT plan", true], ["openai-api", "OpenAI API key", false], ["claude-api", "Claude API key", false]] as const) {
  test(`while ${name}'s status is read, Advanced already names it, and states a tier only for an OpenAI key`, async ({ page }) => {
    let answer!: () => void;
    const answered = new Promise<void>(resolve => { answer = resolve; });
    const basics = { connection, keys: { openai: true, claude: true } };
    await page.route("**/desktop/connection?quick", route => route.fulfill({ json: basics }));
    await page.route("**/desktop/connection", async route => { await answered; await route.fulfill({ json: {
      ...basics, claude: { connected: true, usage: { plan: "Max", percentLeft: 80, weekly: true } }, chatgpt: { connected: true, usage: { plan: "Plus", percentLeft: 70, weekly: true } } } }); });
    await page.goto(origin);
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const row = page.locator(".settings-connection-row");
    await expect(row.locator("strong").first()).toHaveText(new RegExp(name));
    await expect(row.locator(".settings-status-chip")).toHaveText("Checking…");
    await expect(row.getByRole("button", { name: "Change" })).toBeDisabled();
    // The tier is changed beside the OpenAI key, never on this sheet.
    await expect(page.getByRole("radiogroup", { name: /service tier/i })).toHaveCount(0);
    answer();
    await expect(row.locator(".settings-status-chip")).toHaveText("Connected");
    if (connection === "openai-api") await expect(row).toContainText(/(Standard|Flex) tier/);
    else await expect(row).not.toContainText(/ tier/);
    // A key's white glyph shows only on its filled tile.
    if (!subscribed) await expect(row.locator(".settings-connection-tile")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    if (subscribed) await expect(row).toContainText(connection === "claude-subscription" ? "Max plan · 80%" : "Plus plan · 70%");
    await expect(row.getByRole("button", { name: "Change" })).toBeEnabled();
  });
}

test("before even the connection is known, Advanced claims nothing and offers no tier", async ({ page }) => {
  await page.route("**/desktop/connection**", () => new Promise(() => {}));
  await page.goto(origin);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.locator(".settings-connection-row strong").first()).toHaveText("AI connection");
  await expect(page.locator(".settings-connection-row")).not.toContainText(/ tier/);
  await expect(page.getByRole("radiogroup", { name: /service tier/i })).toHaveCount(0);
});

test("a large display widens a Memory page's line at the laptop's type size", async ({ page }) => {
  const measure = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/memory?page=alpha-concept`);
    const prose = page.locator(".kb-prose");
    await expect(prose).toContainText("It was read at");
    return prose.evaluate(element => ({
      size: getComputedStyle(element.querySelector("p") ?? element).fontSize,
      title: getComputedStyle(document.querySelector(".kb-page-header h2")!).fontSize,
      line: Math.round(element.getBoundingClientRect().width),
    }));
  };
  const laptop = await measure(1512, 945);
  const large = await measure(2560, 1440);
  expect(large.size).toBe(laptop.size);
  expect(large.title).toBe(laptop.title);
  expect(large.line).toBeGreaterThan(laptop.line * 1.4);
});
