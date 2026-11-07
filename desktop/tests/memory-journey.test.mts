/**
 * Memory, through the desktop UI, against the real backend.
 *
 * The built UI behind the real host and the plan adapter the app mounts, the
 * pinned backend on a local profile in a temp directory, and the web rig's
 * scripted provider (`DELPHI_E2E_PROVIDER`) as the only model. Nothing under
 * /api is mocked, so a key the UI and the backend name differently fails here
 * where the browser specs, which serve hand-written fixtures, pass.
 *
 * The steps are one reader's session on one profile, in order: documents filed
 * from the Reader, the pages, map and Health they leave, a question beside a
 * document that names Memory, the session that leaving the document files, a
 * Memory chat, Health while the window drains a new document, and search
 * finding the Memory chat again. A step after a failed one is skipped.
 *
 * The provider files every document of a "Shared Idea Study <token>" series
 * into one concept page, `shared-idea-<token>`, and any other document into
 * `prefix-reuse-<paper id>`. A session whose question says "Worth keeping:"
 * adds what it worked out to the concept page of the document beside it.
 *
 * One browser engine per run, named by `DELPHI_JOURNEY_BROWSER` (`chromium`
 * or `webkit`); without it the journey skips. Browser runs on the development
 * machine go through its memory guard, one engine at a time.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";

import { engine, type Browser, type Locator, type Page } from "./fixtures/memory-journey/browser.mts";
import { notePdf } from "./fixtures/memory-journey/documents.mts";
import { memoryWorkspace, missing, type Workspace } from "./fixtures/memory-journey/workspace.mts";

/** Where Memory's pages live in the UI. */
const MEMORY_PAGE_PATH = "/memory";
/** An old bookmark of a Memory page, from before 0.7.0: it must still open Memory. */
const MEMORY_BOOKMARK = "/knowledge-base";
/** How search subtitles a Memory conversation. */
const MEMORY_CHAT_SUBTITLE = "Memory";
/** The Memory routes the journey reads behind the UI. */
const MEMORY_API = "/api/memory";

const ENGINE = process.env.DELPHI_JOURNEY_BROWSER ?? "";
const journey = { skip: ENGINE ? false : "set DELPHI_JOURNEY_BROWSER to chromium or webkit, one engine per run" };
const ARTIFACTS = process.env.DELPHI_JOURNEY_ARTIFACTS || join(tmpdir(), "delphi-memory-journey");

const USER = "journey";
const token = Date.now().toString(36);
const TITLES = { a: `Shared Idea Study ${token} A`, b: `Shared Idea Study ${token} B`, c: "Harbour Bell Notes" };
const CONCEPT = `shared-idea-${token}`;
const CONCEPT_TITLE = `Shared idea ${token}`;
/** Words the provider writes: how its ordinary answer opens, what it files, and how it composes a domain. */
const ANSWER_OPENING = "Prefix caching reuses";
const FILED = "Prefix caching reuses exact matching tokens";
const COMPOSED = "report on the same question";
const WORKED_OUT = "Asked again in a session: a matching prefix is reused when only the question changes.";
/** A word only the Memory chat says, for search to find it by. */
const FIND = "lanternfish";

type Paper = { id: string; slug: string; title: string };
type Summary = { slug: string; kind: string; domain: string; title: string; revision: number; sourcePaperId?: string | null };
type Overview = {
  pages: Summary[];
  domains: Array<{ slug: string; title: string }>;
  events: Array<{ kind: string; requestId?: string; outcome?: string }>;
};
type Job = { id: string; kind: string; status: string; marker: string; payload?: { paperId?: string | null }; lastError: string | null };
type Queue = { pending: number; leased: number; due: number; failed: number; cancellable: number; jobs: Job[] };

let w!: Workspace;
let browser: Browser | undefined;
let page!: Page;
let project!: { id: string; slug: string };
const papers = {} as Record<keyof typeof TITLES, Paper>;
const sources = {} as Record<"a" | "b", Summary>;
let domain!: { slug: string; title: string; page: string };
let conceptBefore!: Summary & { body: string };
let memoryChat = "";
const pageErrors: string[] = [];
/** When the window asked the queue to drain. */
const drains: number[] = [];

before(async () => {
  if (!ENGINE) return;
  const absent = missing();
  if (absent.length) throw new Error(`The Memory journey needs ${absent.join("; ")}`);
  const type = engine(ENGINE);
  w = await memoryWorkspace(USER);
  project = await w.api<{ id: string; slug: string }>("/api/projects", { name: "Memory journey" });
  browser = await type.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(30_000);
  const split = w.cookie.indexOf("=");
  await context.addCookies([{ name: w.cookie.slice(0, split), value: w.cookie.slice(split + 1), url: w.origin }]);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `${MEMORY_API}/maintenance/drain`) drains.push(Date.now());
  });
});

after(async () => {
  await browser?.close().catch(() => undefined);
  await w?.close();
});

let broken = "";
/** One step of the journey. Each builds on the last, so one that fails skips the rest rather than failing them too. */
function step(name: string, minutes: number, run: () => Promise<void>) {
  test(name, { ...journey, timeout: minutes * 60_000 }, async (t) => {
    if (broken) return t.skip(`"${broken}" failed`);
    try {
      await run();
    } catch (error) {
      broken = name;
      await evidence(t, name);
      throw error;
    }
  });
}

/** What a failure leaves to read: a screenshot, what the provider refused, the queue, and both logs. */
async function evidence(t: TestContext, name: string) {
  const lines: string[] = [];
  try {
    lines.push(`at ${page.url()}`);
    mkdirSync(ARTIFACTS, { recursive: true });
    const file = join(ARTIFACTS, `${ENGINE}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.png`);
    await page.screenshot({ path: file, fullPage: true });
    lines.push(`screenshot: ${file}`);
  } catch (error) { lines.push(`no screenshot: ${String(error)}`); }
  try { lines.push(`provider refused: ${JSON.stringify(await w.refusals())}`); } catch { /* the provider is gone */ }
  try { lines.push(`queue: ${JSON.stringify(await queue())}`); } catch { /* the backend is gone */ }
  if (pageErrors.length) lines.push(`page errors: ${pageErrors.join(" | ")}`);
  lines.push(w?.logs() ?? "");
  for (const line of lines.join("\n").split("\n")) t.diagnostic(line);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask `probe` until it answers, or fail saying what was awaited. An error from the probe fails at once. */
async function until<T>(what: string | (() => string), probe: () => Promise<T | false | null | undefined>, timeout = 60_000): Promise<T> {
  for (const deadline = Date.now() + timeout; ;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${typeof what === "string" ? what : what()}`);
    await delay(250);
  }
}

/** The page shows `locator`, or the first of what it matches. */
const shows = (locator: Locator, timeout = 30_000) => locator.first().waitFor({ state: "visible", timeout });

/** `locator`, one element, holds exactly `text`, as written rather than as styled. */
async function reads(locator: Locator, text: string, timeout = 30_000) {
  let seen = "";
  await until(() => `${locator} to read ${JSON.stringify(text)}, not ${seen}`, async () => {
    const found = await locator.count();
    seen = found === 1 ? JSON.stringify(((await locator.textContent()) ?? "").replace(/\s+/g, " ").trim()) : `${found} elements`;
    return seen === JSON.stringify(text);
  }, timeout);
}

async function counts(locator: Locator, expected: number, timeout = 30_000) {
  let seen = -1;
  await until(() => `${expected} of ${locator}, not ${seen}`, async () => (seen = await locator.count()) === expected, timeout);
}

/** The window's address is `pathname`, with each of `params`. */
async function at(pathname: string, params: Record<string, string> = {}) {
  await until(() => `the address ${pathname}?${new URLSearchParams(params)}, not ${page.url()}`, async () => {
    const url = new URL(page.url());
    return url.pathname === pathname && Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
  });
}

const pagePath = (slug: string) => `${MEMORY_PAGE_PATH}?page=${encodeURIComponent(slug)}`;
const heading = () => page.locator(".kb-page-header h2");
const prose = () => page.locator(".kb-prose");

/** The open Memory page is of `kind`, and its badge says so. */
const kindIs = (kind: string, label: string) => reads(page.locator(`.kb-page-header .kb-kind.kb-kind-${kind}`), label);

const queue = () => w.api<Queue>(`${MEMORY_API}/maintenance`);
const memory = () => w.api<Overview>(MEMORY_API);
const stored = async (slug: string) => (await w.api<{ page: Summary & { body: string } }>(`${MEMORY_API}/pages/${encodeURIComponent(slug)}`)).page;
const projectPapers = async () => (await w.api<{ papers: Paper[] }>(`/api/projects/${project.id}`)).papers;

/**
 * Until no Memory job is due or running. A job that failed fails the step at
 * once, with why. With `drain`, due work is also run from here, as a
 * foreground window would run it; without, only the window runs it.
 */
async function settled({ drain = true } = {}) {
  let last: Queue | undefined;
  return until(() => `the Memory queue to settle: ${JSON.stringify(last)}`, async () => {
    last = await queue();
    if (last.failed) {
      throw new Error(`A Memory job failed: ${JSON.stringify(last.jobs.filter((job) => job.status === "failed"))}\n`
        + `The provider refused: ${JSON.stringify(await w.refusals())}`);
    }
    if (!last.due && !last.leased) return last;
    if (drain && last.due) await w.api(`${MEMORY_API}/maintenance/drain`, {});
    return undefined;
  }, 180_000);
}

/** Until Memory says every one of `ids` is filed, running what is due meanwhile. */
async function filed(ids: string[]) {
  await until(`documents ${ids.join(", ")} to be filed`, async () => {
    const { papers: listed } = await w.api<{ papers: Array<{ paperId: string; filed: boolean }> }>(`${MEMORY_API}/backfill/papers`);
    if (ids.every((id) => listed.some((paper) => paper.paperId === id && paper.filed))) return true;
    await settled();
    return false;
  }, 180_000);
}

async function nothingRefused() {
  assert.deepEqual(await w.refusals(), [], "the provider played every request as a model would");
}

/** Ask the open chat one question and wait for the whole answer. Answers the request the composer sent, and the turn. */
async function ask(prompt: string) {
  await page.getByRole("textbox", { name: /^(Ask Delphi anything|Hint: press \/side)/ }).fill(prompt);
  const sent = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/chat/stream");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const request = await sent;
  const response = await request.response();
  assert.ok(response, "the chat stream was answered");
  assert.equal(response.status(), 200, `the chat stream: ${response.status()}`);
  await response.finished();
  const turn = page.locator(".kb-chat-turn").last();
  await shows(turn.filter({ hasText: ANSWER_OPENING }), 60_000);
  await counts(page.getByRole("button", { name: "Stop", exact: true }), 0, 60_000);
  return { body: request.postDataJSON() as Record<string, unknown>, turn };
}

/** The answer names the concept page: a link drawn in its kind, and a row under Sources. Answers the row. */
async function namesConcept(turn: Locator): Promise<Locator> {
  const link = turn.locator("a.kb-link.kb-link-concept", { hasText: CONCEPT_TITLE });
  await shows(link);
  assert.equal(await link.first().getAttribute("href"), pagePath(CONCEPT));
  assert.doesNotMatch(await turn.innerText(), /\[\[|\]\]/, "no bracket of the page's name shows");
  await turn.locator(".answer-sources-toggle").click();
  const row = turn.locator('.answer-sources-list section[aria-label="Memory"] .answer-source', { hasText: CONCEPT_TITLE });
  await shows(row);
  return row.first();
}

step("documents filed from the Reader leave Memory pages of each kind", 8, async () => {
  await page.goto(`${w.origin}/@${USER}/${project.slug}`);
  // One at a time, so the second finds the concept page the first wrote.
  for (const key of ["a", "b"] as const) {
    const known = new Set((await projectPapers()).map((paper) => paper.id));
    // The library's own file input, which choosing a PDF in the Reader fills.
    await page.locator(".library-footer input[type=file]").setInputFiles({
      name: `${TITLES[key]}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(notePdf(key.toUpperCase())),
    });
    papers[key] = await until(`${TITLES[key]} in the library`, async () => (await projectPapers()).find((paper) => !known.has(paper.id)));
    assert.equal(papers[key].title, TITLES[key], "a document is named by the file it came from");
    await shows(page.locator(`.paper-row[data-paper-id="${papers[key].id}"]`));
    await filed([papers[key].id]);
    await settled();
  }

  const filedMemory = await memory();
  const of = (kind: string) => filedMemory.pages.filter((entry) => entry.kind === kind);
  assert.deepEqual(filedMemory.pages.map((entry) => entry.kind).filter((kind) => !["source", "concept", "domain"].includes(kind)), []);
  for (const key of ["a", "b"] as const) {
    const source = of("source").find((entry) => entry.sourcePaperId === papers[key].id);
    assert.ok(source, `${TITLES[key]} has a page of its own`);
    sources[key] = source;
  }
  // The second document edited the concept page the first created, rather than writing another.
  assert.deepEqual(of("concept").map((entry) => entry.slug), [CONCEPT]);
  const concept = of("concept")[0]!;
  // Two sources and their concept are enough members for the domain to have a page written for it.
  assert.deepEqual(of("domain").map((entry) => entry.slug), [concept.domain]);
  const record = filedMemory.domains.find((entry) => entry.slug === concept.domain);
  assert.ok(record, `a record for the domain ${concept.domain}`);
  domain = { slug: concept.domain, title: record.title, page: of("domain")[0]!.title };
  for (const key of ["a", "b"] as const) {
    assert.ok(filedMemory.events.some((event) => event.kind === "document" && event.requestId === `paper:${papers[key].id}` && event.outcome === "filed"),
      `the log says ${TITLES[key]} was filed: ${JSON.stringify(filedMemory.events)}`);
  }
  await nothingRefused();
});

step("a Memory page, the map and Health show what was filed", 4, async () => {
  // An old bookmark opens the page where Memory lives now.
  await page.goto(`${w.origin}${MEMORY_BOOKMARK}?page=${encodeURIComponent(CONCEPT)}`);
  await at(MEMORY_PAGE_PATH, { page: CONCEPT });
  await reads(heading(), CONCEPT_TITLE);
  await kindIs("concept", "Concept");
  await shows(prose().filter({ hasText: FILED }));
  conceptBefore = await stored(CONCEPT);

  // Its prose links the page of each document it rests on; one opens in place.
  await counts(prose().locator(`a.kb-link[href="${pagePath(sources.b.slug)}"]`), 1);
  await prose().locator(`a.kb-link[href="${pagePath(sources.a.slug)}"]`).first().click();
  await at(MEMORY_PAGE_PATH, { page: sources.a.slug });
  await reads(heading(), TITLES.a);
  await kindIs("source", "Source");

  // The map, and the domain in the tree beside it: the three pages filed there, by kind.
  await page.goto(`${w.origin}${MEMORY_PAGE_PATH}/graph`);
  await shows(page.getByRole("img", { name: "Memory map", exact: true }));
  const tree = page.getByRole("navigation", { name: "Domains", exact: true });
  const fold = tree.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${domain.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
  if (await fold.getAttribute("aria-expanded") !== "true") await fold.click();
  const filedThere = tree.locator(".kb-memory-pages");
  for (const title of [CONCEPT_TITLE, TITLES.a, TITLES.b]) await shows(filedThere.locator(".kb-memory-page-title", { hasText: title }));
  await counts(filedThere.locator(".kb-memory-dot-concept"), 1);
  await counts(filedThere.locator(".kb-memory-dot-source"), 2);

  // The domain's name opens the page written for it.
  await tree.locator(".kb-memory-domain-name", { hasText: domain.title }).first().click();
  await at(MEMORY_PAGE_PATH, { page: domain.slug });
  await reads(heading(), domain.page);
  await kindIs("domain", "Domain");
  await shows(prose().filter({ hasText: COMPOSED }));
  await shows(prose().locator(`a.kb-link[href="${pagePath(CONCEPT)}"]`));

  // Health is a view of its own, with every edit filing made in its log.
  const views = page.getByRole("tablist", { name: "Memory view", exact: true });
  await views.getByRole("tab", { name: "Health", exact: true }).click();
  await at(`${MEMORY_PAGE_PATH}/health`);
  assert.equal(await views.getByRole("tab", { name: "Health", exact: true }).getAttribute("aria-selected"), "true");
  await shows(page.locator(".kb-health"));
  await shows(page.locator(".kb-log .kb-activity-title", { hasText: CONCEPT_TITLE }));
  await shows(page.getByRole("button", { name: "Run health check", exact: true }));
});

step("a question beside a document names its Memory page, as a link and as a source", 4, async () => {
  await page.goto(`${w.origin}/@${USER}/${project.slug}/${papers.a.slug}?chat=paper`);
  const { body, turn } = await ask("Worth keeping: why does a changed question leave the shared opening reusable?");
  assert.equal(body.desktop_mode, "chat");
  assert.equal(body.paper_id, papers.a.id);
  await namesConcept(turn);
  await nothingRefused();

  // What the session worked out waits while the reader stays beside the document.
  const held = await until("the session's job", async () => (await queue()).jobs.find((job) => job.kind === "session"
    && (job.payload?.paperId === papers.a.id || job.marker.includes(papers.a.id))));
  assert.equal(held.status, "pending", JSON.stringify(held));
  assert.equal((await stored(CONCEPT)).revision, conceptBefore.revision, "nothing is filed before the reader leaves");
});

step("leaving the document files what its session worked out", 5, async () => {
  const expand = page.getByRole("button", { name: "Expand library", exact: true });
  if (await expand.isVisible()) await expand.click();
  const [release] = await Promise.all([
    page.waitForRequest((request) => request.method() === "POST"
      && new URL(request.url()).pathname === `${MEMORY_API}/sessions/release` && Boolean(request.postData())),
    page.locator(`.paper-row[data-paper-id="${papers.b.id}"] .paper-row-main`).click(),
  ]);
  assert.deepEqual(release.postDataJSON(), { paperId: papers.a.id, projectId: project.id });

  await settled();
  const revised = await until("the session's edit of the concept page", async () => {
    const now = await stored(CONCEPT);
    return now.revision > conceptBefore.revision ? now : undefined;
  });
  assert.equal(revised.revision, conceptBefore.revision + 1);
  // Every word the page had is still there, and what the session worked out follows it.
  assert.ok(revised.body.startsWith(conceptBefore.body.trimEnd()), revised.body);
  assert.ok(revised.body.slice(conceptBefore.body.trimEnd().length).includes(WORKED_OUT), revised.body);
  const sessions = (await memory()).events.filter((event) => event.kind === "session" && event.requestId === `session:paper:${papers.a.id}`);
  assert.deepEqual(sessions.map((event) => event.outcome), ["filed"]);
  await nothingRefused();

  await page.goto(`${w.origin}${pagePath(CONCEPT)}`);
  await shows(prose().filter({ hasText: WORKED_OUT }));
});

step("a Memory chat names a page, and its source opens the page beside the chat", 4, async () => {
  await page.goto(`${w.origin}${pagePath(domain.slug)}&ask=1`);
  await reads(heading(), domain.page);
  const { body, turn } = await ask(`What do my pages say about the ${FIND} opening?`);
  assert.equal(body.scope, "general");
  assert.equal(typeof body.conversation_id, "string");
  memoryChat = body.conversation_id as string;
  const source = await namesConcept(turn);
  await nothingRefused();

  await source.click();
  await at(MEMORY_PAGE_PATH, { page: CONCEPT });
  await reads(heading(), CONCEPT_TITLE);
  // The conversation stays docked beside the page it opened.
  await shows(page.locator(".kb-chat-turn", { hasText: ANSWER_OPENING }));
});

step("Health shows the window filing a new document, and settles when its drain ends", 6, async () => {
  // The provider keeps this document's filing waiting mid-run until released, so Health can be read while it runs.
  await w.fixture("/hold", { format: "memory_file_selection", contains: [TITLES.c] });
  papers.c = await w.upload(project.id, `${TITLES.c}.pdf`, notePdf("C"));
  assert.equal(papers.c.title, TITLES.c);
  const asked = drains.length;

  // A window that opens drains the queue itself.
  await page.goto(`${w.origin}${MEMORY_PAGE_PATH}/health`);
  await until("the new document's filing to be under way", async () => (await w.fixture<{ holding: boolean }>("/hold")).holding, 90_000);
  assert.ok(drains.length > asked, "the window asked the queue to drain");
  const foot = page.locator(".kb-memory-rail .kb-health-status");
  await shows(foot.getByRole("status").filter({ hasText: "Filing" }));
  await shows(foot.getByRole("button", { name: "Stop filing", exact: true }));

  const released = await w.fixture<{ released: Array<{ state: string }> }>("/hold/release", {});
  assert.deepEqual(released.released.map((hold) => hold.state), ["holding"]);
  await counts(foot, 0, 120_000);
  await filed([papers.c.id]);
  await settled();
  await nothingRefused();

  // The log is read when Health opens: the new document's page is in it.
  await page.reload();
  await shows(page.locator(".kb-log .kb-activity-title", { hasText: `Prefix reuse ${papers.c.id}` }));
});

step("search finds the Memory chat under its Memory label, and opens it beside the map", 4, async () => {
  await page.goto(`${w.origin}/`);
  await shows(page.getByRole("heading", { name: "Recent threads", exact: true }));
  const search = page.getByRole("dialog", { name: "Search Delphi", exact: true });
  // ⌘K is heard once the window knows who is signed in, which can be a frame after Home draws.
  await until("⌘K to open search", async () => {
    await page.keyboard.press("ControlOrMeta+KeyK");
    return search.isVisible();
  }, 15_000);
  await search.getByRole("textbox", { name: "Search pages, documents and chats", exact: true }).fill(FIND);
  // The group headed Chats: its heading is the first thing it says.
  const chats = search.locator(".search-group", { hasText: /^\s*Chats/ });
  const hit = chats.locator(".search-result", { hasText: FIND });
  await shows(hit);
  await counts(hit, 1);
  await reads(hit.locator(".search-result-where"), MEMORY_CHAT_SUBTITLE);

  await hit.click();
  await at(`${MEMORY_PAGE_PATH}/graph`, { ask: "1", conversation: memoryChat });
  await shows(page.locator(".message-bubble", { hasText: FIND }));
  await shows(page.locator(".kb-chat-turn", { hasText: ANSWER_OPENING }));
  await nothingRefused();
});

step("a source page opens its document after the move, and a capture no longer kept says so", 4, async () => {
  // The document moves to another project and the one it was filed in is deleted, as a reader tidies up.
  const tidied = await w.api<{ id: string; slug: string }>("/api/projects", { name: "Tidied" });
  await w.api(`/api/projects/${project.id}/papers/${papers.a.id}/move`, { project_id: tidied.id });
  await w.remove(`/api/projects/${project.id}`);
  const moved = (await w.api<{ papers: Paper[] }>(`/api/projects/${tidied.id}`)).papers.find((paper) => paper.id === papers.a.id);
  assert.ok(moved, `${TITLES.a} is in the project it moved to`);

  // Its page cites two outside sources: one captured, and one whose capture was removed before the page was read.
  // Written once nothing is filing, so no pass rewrites the page under the edit.
  await settled();
  const memoryDir = join(w.dataDir, "users", USER, "memory");
  const file = join(memoryDir, "pages", `${sources.a.slug}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  const next = Math.max(0, ...record.citations.map((citation: { id: number }) => citation.id)) + 1;
  const [kept, gone] = ["0".repeat(23) + "1", "0".repeat(23) + "2"];
  record.body += ` The open web adds a caveat [E${next}], and another [E${next + 1}].`;
  record.citations.push(
    { id: next, claimType: "external", evidenceId: kept, section: "limits", paperId: null, page: null, noteId: null },
    { id: next + 1, claimType: "external", evidenceId: gone, section: "intro", paperId: null, page: null, noteId: null },
  );
  writeFileSync(file, JSON.stringify(record));
  mkdirSync(join(memoryDir, "evidence"), { recursive: true });
  writeFileSync(join(memoryDir, "evidence", `${kept}.json`), JSON.stringify({ sections: [{ anchor: "limits", title: "Limits", level: 2, markdown: "Post-norm networks are not covered." }] }));
  const evidenceFile = join(memoryDir, "evidence.json");
  writeFileSync(evidenceFile, JSON.stringify([{
    id: kept, url: "https://outside.example/depth", finalUrl: "https://outside.example/depth", title: "Depth scaling, revisited",
    contentHash: "0", findings: [], objectKey: `knowledge/u/${USER}/evidence/${kept}.json`, capturedAt: "2026-10-30T00:00:00+00:00",
  }]));

  await page.goto(`${w.origin}${pagePath(sources.a.slug)}`);
  await kindIs("source", "Source");
  const provenance = page.getByRole("region", { name: "Where this page comes from" });
  await provenance.locator(".kb-provenance-toggle").click();
  const rows = provenance.locator(".kb-provenance-entry").filter({ hasText: /outside source/i });
  await counts(rows, 2);
  // The removed capture is text, in the row and in the prose: nothing offers to open it.
  await reads(rows.nth(1).locator(".kb-provenance-entry-name"), "Outside source, no longer kept");
  await reads(rows.nth(1).locator(".kb-provenance-section"), "§intro");
  await counts(rows.nth(1).getByRole("button"), 0);
  await counts(prose().getByRole("button", { name: `E${next + 1}`, exact: true }), 0);

  // The kept one opens what the page said.
  await prose().getByRole("button", { name: `E${next}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Depth scaling, revisited" });
  await shows(dialog.locator("article", { hasText: "Post-norm networks are not covered." }));
  await page.getByRole("button", { name: "Close captured source" }).click();
  await counts(dialog, 0);

  // Removed while the page is open, it opens nothing: the bottom toast says so, and leaves on its own.
  writeFileSync(evidenceFile, "[]");
  await rows.nth(0).getByRole("button", { name: "outside source", exact: true }).click();
  const toast = page.locator(".toast.toast-hint", { hasText: "The captured copy of that source is no longer kept." });
  await shows(toast);
  await counts(page.getByRole("dialog"), 0);
  await counts(toast, 0, 15_000);

  // Open document finds the document where it is now.
  await page.getByRole("button", { name: "Open document" }).click();
  await at(`/@${USER}/${tidied.slug}/${moved.slug}`);

  // Deleted from the library, the page it left behind is the reader's to delete, and opens nothing.
  await w.remove(`/api/projects/${tidied.id}/papers/${papers.a.id}`);
  await page.goto(`${w.origin}${pagePath(sources.a.slug)}`);
  await kindIs("source", "Source");
  const left = page.getByRole("button", { name: "Delete page (document removed)" });
  await shows(left);
  assert.equal(await left.isDisabled(), false);
  await counts(page.getByRole("button", { name: "Open document" }), 0);
});
