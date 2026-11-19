import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { freePort } from "../../../main/ports.ts";
import { startWorkerHost } from "../../../main/worker-host.ts";
import { DEFAULT_APP_CONFIG, type DigestDetail, type Highlight, type Note, type Paper, type PaperDigestMetadata, type Project } from "../../app/lib/api.ts";
import { DEFAULT_CHAT_CONFIG, modelLabel } from "../../app/lib/chat-model-policy.ts";
import { digestFixture } from "./digest-fixture.ts";

// The digest as a reader meets it: the production reader, its header toggle
// and its library, over routed API answers. A digest is written over the real
// stream route, held open by the spec, so progress arrives while it reads.
type DigestStream = { paperId: string; force: boolean; send: (event: object) => void; end: () => void };
const streams: DigestStream[] = [];
let host: Awaited<ReturnType<typeof startWorkerHost>>;
let origin: string;
test.beforeAll(async () => {
  const port = await freePort("127.0.0.1");
  origin = `http://127.0.0.1:${port}`;
  host = await startWorkerHost({
    distDir: fileURLToPath(new URL("../../../.delphi-build/dist", import.meta.url)),
    backendUrl: "http://127.0.0.1:9",
    uiHost: "127.0.0.1", uiPort: port,
    desktopHandler: async request => {
      const paperId = new URL(request.url).pathname.match(/^\/api\/projects\/project\/papers\/([^/]+)\/digest\/stream$/)?.[1];
      if (!paperId || request.method !== "POST") return undefined;
      const { force } = await request.json() as { force: boolean };
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: value => { controller = value; } });
      streams.push({ paperId, force, send: event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), end: () => controller.close() });
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    },
  });
});
test.afterAll(async () => {
  if (host) await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
});
test.beforeEach(() => { streams.length = 0; });
test.afterEach(() => { for (const stream of streams.splice(0)) try { stream.end(); } catch { /* already closed */ } });

/** An eight-page Letter PDF, one line of text per page; xref offsets computed. */
function pdf(pages = 8) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let page = 1; page <= pages; page++) {
    const text = `BT /F1 24 Tf 72 700 Td (Page ${page} of the document.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(at => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

const model = DEFAULT_CHAT_CONFIG.defaultModel;
/** One project: a paper with a stored digest, one never digested, one whose digest failed, one the
 *  backend is still writing, and a web page. `served` overrides what `GET …/digest` answers;
 *  `annotations` are the stored highlights and notes; `routes` answer anything else by path. */
function library() {
  const paper = (id: string, slug: string, title: string, digest: PaperDigestMetadata, extra: Partial<Paper> = {}): Paper =>
    ({ id, slug, title, filename: `${slug}.pdf`, pages: 8, tokens: 4000, digest, ...extra });
  const papers = [
    paper("sglang", "sglang", "SGLang: Efficient Execution of Structured Language Model Programs", { status: "ready", model, updatedAt: "2026-10-26T09:30:00Z" }),
    paper("draft", "draft-notes", "Draft notes on decoding", { status: "missing" }),
    paper("broken", "speculative", "Speculative decoding survey", { status: "failed", message: "The model stopped after page 5 of 8." }),
    paper("pending", "paged-attention", "Paged attention", { status: "pending" }),
    paper("web", "kv-cache-post", "Notes on KV caches", { status: "missing" }, { kind: "web", filename: "kv-cache-post.html", url: "https://blog.example/kv-cache", pages: 0 }),
  ];
  const project: Project = { id: "project", slug: "inference", name: "Inference systems", owner: "reader", updatedAt: "2026-10-26T09:30:00Z", paperCount: papers.length, papers };
  const digests: Record<string, DigestDetail> = { sglang: { paper: papers[0], digest: structuredClone(digestFixture.digest) } };
  return {
    project, digests,
    served: {} as Record<string, DigestDetail>,
    annotations: { highlights: [] as Highlight[], notes: [] as Note[] },
    routes: {} as Record<string, unknown>,
  };
}
type Library = ReturnType<typeof library>;

async function openReader(page: Page, reader: Library, slug: string, query = "") {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/digest/stream")) return route.continue();
    const json = (value: unknown) => route.fulfill({ json: value });
    const [, paperId, resource] = path.match(/^\/api\/projects\/project\/papers\/([^/]+)\/([a-z-]+)$/) ?? [];
    if (paperId) {
      const paper = reader.project.papers.find(item => item.id === paperId)!;
      switch (resource) {
        case "file": return route.fulfill({ contentType: "application/pdf", body: pdf() });
        case "highlights": return json(paperId === "sglang" ? reader.annotations.highlights : []);
        case "notes": return json(paperId === "sglang" ? reader.annotations.notes : []);
        case "digest": return json(reader.served[paperId] ?? { paper, digest: reader.digests[paperId]?.digest ?? null });
        case "engagement": return route.fulfill({ status: 204 });
        case "done":
          paper.doneAt = request.postDataJSON().done ? "2026-10-29T10:00:00Z" : undefined;
          return json(paper);
      }
    }
    const document = path.match(/^\/api\/reader\/reader\/inference\/([^/]+)$/)?.[1];
    if (path in reader.routes) return json(reader.routes[path]);
    if (document) return json({ project: reader.project, paperId: reader.project.papers.find(item => item.slug === document)?.id ?? null });
    switch (path) {
      case "/api/auth/me": return json({ username: "reader", useStandardTier: true });
      case "/api/config": return json({ ...DEFAULT_APP_CONFIG, webDocumentsEnabled: true, memoryEnabled: false });
      case "/api/onboarding/resolve": return json({ onboarding: false });
      case "/api/projects": return json([reader.project]);
      case "/api/projects/project": return json(reader.project);
      case "/api/personas": return json({ official: [], mine: [] });
      case "/api/chat/conversations": return json({ items: [], defaultId: null, limit: 10 });
    }
    return route.fulfill({ status: 404, json: { detail: "No fixture for this route" } });
  });
  await page.goto(`${origin}/@reader/inference/${slug}${query}`);
  await expect(toggle(page)).toBeVisible();
}

/** The next digest the reader asked for, once its request has arrived. */
async function nextStream(paperId: string) {
  await expect.poll(() => streams.some(stream => stream.paperId === paperId)).toBe(true);
  return streams.splice(streams.findIndex(stream => stream.paperId === paperId), 1)[0];
}
/** The digest finishes, and the library stores it as the backend would. */
function finish(reader: Library, stream: DigestStream, contentMarkdown: string) {
  const paper = reader.project.papers.find(item => item.id === stream.paperId)!;
  paper.digest = { status: "ready", model, updatedAt: "2026-10-29T10:00:00Z" };
  const digest = { contentMarkdown, citations: [{ id: 1, claimType: "author-claim" as const, page: 2, section: null }], assets: [] };
  reader.digests[paper.id] = { paper, digest };
  stream.send({ type: "done", paper, digest });
  stream.end();
}
function fail(reader: Library, stream: DigestStream, message: string) {
  const paper = reader.project.papers.find(item => item.id === stream.paperId)!;
  paper.digest = reader.digests[paper.id] ? paper.digest : { status: "failed", message };
  stream.send({ type: "error", message });
  stream.end();
}

const toggle = (page: Page) => page.getByRole("group", { name: "Show", exact: true });
const documentButton = (page: Page) => toggle(page).getByRole("button", { name: "Document", exact: true });
// The mark's tooltip may join the button's name, so its label ends it.
const digestButton = (page: Page) => toggle(page).getByRole("button", { name: /Digest$/ });
const mark = (page: Page) => digestButton(page).locator(".digest-mark");
const tooltip = (page: Page) => digestButton(page).evaluate(button => button.getAttribute("title") || button.querySelector(".digest-mark")?.getAttribute("title"));
/** The animation that carries the mark's state, read off the style rather than timed:
 *  the ping ring's for "new", the mark's own otherwise. */
const motion = (page: Page) => mark(page).evaluate(node =>
  getComputedStyle(node, node.getAttribute("data-state") === "new" ? "::after" : null).animationName);
const pane = (page: Page) => page.locator('section[aria-label="Digest"]');
const pager = (page: Page) => page.locator(".pdf-pager span");
const row = (page: Page, title: string) => page.locator(".paper-row-main", { hasText: title });
type Box = { x: number; y: number; width: number; height: number };
const box = async (locator: Locator) => (await locator.boundingBox())!;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

test("a PDF opens on the document, and Digest swaps the page box for its digest and back", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "sglang");
  await expect(page.locator(".reader-project-label")).toHaveText("Inference systems");
  await expect(page.locator(".reader-heading h1")).toBeVisible();
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(digestButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  expect(await tooltip(page)).toBe("Research digest");
  await expect(pane(page)).toBeHidden();

  // Read partway in, then look at the digest.
  await expect(pager(page)).toHaveText("1 / 8");
  await page.locator(".pdf-scroll").evaluate(node => node.scrollTo({ top: node.scrollHeight / 2 }));
  await expect(pager(page)).not.toHaveText("1 / 8");
  const scrolled = await page.locator(".pdf-scroll").evaluate(node => node.scrollTop);
  const where = await pager(page).textContent();
  const panel = await box(page.locator(".reader-panel"));
  const pagerBox = await box(page.locator(".pdf-pager"));
  // A crossfade, never a slide: the layers changing only fade. Recorded as each
  // transition starts, so a loaded machine cannot finish it before it is read.
  await page.evaluate(() => {
    const seen: string[] = (window as unknown as { digestMoved: string[] }).digestMoved = [];
    document.addEventListener("transitionrun", event => {
      const target = event.target as Element;
      if (target.matches('section[aria-label="Digest"], .reader-document')) seen.push(event.propertyName);
    });
  });
  await digestButton(page).click();
  await expect(pane(page)).toBeVisible();
  const moved = await page.evaluate(() => (window as unknown as { digestMoved: string[] }).digestMoved);
  expect(moved).toContain("opacity");
  expect(moved.filter(property => !["opacity", "visibility"].includes(property))).toEqual([]);
  await expect(digestButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  await expect(pane(page).getByRole("navigation", { name: "Contents", exact: true })).toBeVisible();
  // The page box is the same box: the digest sits under the header, inside the reader.
  expect(await box(page.locator(".reader-panel"))).toEqual(panel);
  const digestBox = await box(pane(page));
  expect(inside(digestBox, panel)).toBe(true);
  expect(digestBox.y).toBeGreaterThanOrEqual((await box(page.locator(".reader-heading"))).y + (await box(page.locator(".reader-heading"))).height - 0.5);
  // Its footer is where the pager was, and looks like it; only its spacing is roomier.
  const footer = pane(page).locator(".digest-footer");
  expect(Math.abs((await box(footer)).y + (await box(footer)).height - pagerBox.y - pagerBox.height)).toBeLessThanOrEqual(2);
  const pagerLike = (selector: string) => page.locator(selector).evaluate(node => {
    const style = getComputedStyle(node);
    return [style.display, style.justifyContent, style.padding, style.backgroundColor, style.borderTopWidth];
  });
  expect(await pagerLike(".digest-footer")).toEqual(await pagerLike(".pdf-pager"));
  // The annotation tools are the document's; exporting is not, and Zoom sizes the digest's text.
  await expect(page.locator(".reader-annotation-slot")).toHaveCount(1);
  await expect(page.locator(".reader-annotation-slot")).toBeHidden();
  await more(page).click();
  await expect(page.getByRole("button", { name: "Larger digest text (⌘+)" })).toBeVisible();
  await expect(page.locator(".reader-actions").getByRole("link", { name: "Export PDF", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // The document stays mounted underneath.
  await expect(page.locator(".pdf-scroll")).toHaveCount(1);
  // The knob comes to rest under the pressed segment.
  await expect.poll(async () => Math.round((await box(page.locator(".reader-view-knob"))).x - (await box(digestButton(page))).x)).toBe(0);

  await documentButton(page).click();
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pane(page)).toBeHidden();
  await more(page).click();
  await expect(page.locator(".reader-menu-zoom")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pager(page)).toHaveText(where!);
  expect(await page.locator(".pdf-scroll").evaluate(node => node.scrollTop)).toBe(scrolled);
  await expect.poll(async () => Math.round((await box(page.locator(".reader-view-knob"))).x - (await box(documentButton(page))).x)).toBe(0);
});

test("the toggle shows no focus ring for a click, and a dawn one for the keyboard", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await digestButton(page).click();
  expect(await digestButton(page).evaluate(node => getComputedStyle(node).outlineStyle)).toBe("none");
  // WebKit, like Safari, neither focuses a clicked button nor tabs to one; the app ships in Chromium.
  if (browserName === "webkit") return;
  await expect(digestButton(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(documentButton(page)).toBeFocused();
  expect(await documentButton(page).evaluate(node => { const style = getComputedStyle(node); return [style.outlineStyle, style.outlineWidth, style.outlineColor]; }))
    // Chromium snaps 1.5px to whole device pixels at a ratio of 1.
    .toEqual(["solid", expect.stringMatching(/^1(\.5)?px$/), "rgb(238, 157, 102)"]);
  await page.keyboard.press("Enter");
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("a document without a digest offers one Generate, then shows it being written, then reads it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "draft-notes");
  await expect(mark(page)).toHaveAttribute("data-state", "missing");
  expect(await tooltip(page)).toBe("No digest yet");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "No digest for this document yet", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("A short summary with page references. Later chats read it instead of the whole document.");
  await expect(pane(page)).toContainText("Uses model tokens once.");
  const none = pane(page).locator('img[src="/brand/animations/delphi-digest-none.gif"]');
  await expect(none).toBeVisible();
  expect(await none.evaluate(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height])).toEqual([60, 48]);
  // One way forward; the Document toggle is the way back.
  await expect(pane(page).getByRole("button")).toHaveText(["Generate"]);

  await pane(page).getByRole("button", { name: "Generate", exact: true }).click();
  const stream = await nextStream("draft");
  expect(stream.force).toBe(false);
  await expect(pane(page).getByRole("heading", { name: "Writing the digest", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("A few minutes for a long paper. Keep reading 🚀.");
  await expect(pane(page).locator('img[src="/brand/animations/delphi-loading-sunrise.gif"]')).toBeVisible();
  await expect(pane(page).getByRole("button")).toHaveCount(0);
  await expect(mark(page)).toHaveAttribute("data-state", "preparing");
  expect(await tooltip(page)).toBe("Digest is being written");
  // The chip says what the stream last said.
  await expect(pane(page)).toContainText("Preparing research digest");
  stream.send({ type: "progress", message: "Reading pages 1–8" });
  await expect(pane(page)).toContainText("Reading pages 1–8");
  stream.send({ type: "progress", message: "Waiting for flex capacity (attempt 2)" });
  await expect(pane(page)).toContainText("Waiting for model capacity");

  finish(reader, stream, "## Decoding notes\n\nThe draft's digest is ready, with its evidence `p. 2`.");
  await expect(pane(page).locator(".digest-document")).toContainText("The draft's digest is ready");
  await expect(pane(page).locator(".digest-footer")).toContainText(`${modelLabel(model)} · Oct 29`);
  // The focus Generate had moves on to the digest it asked for, so the keyboard reads it.
  await expect(pane(page).locator(".digest-reading-scroll")).toBeFocused();
  // Read where it finished: nothing new to point at.
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("a failed digest says so, keeps its detail, and Try again recovers", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "speculative");
  await expect(mark(page)).toHaveAttribute("data-state", "failed");
  expect(await tooltip(page)).toBe("The digest didn't finish");
  expect(await motion(page)).toBe("digest-nudge");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("Nothing was saved, and the document is unchanged. Try again; if it stops a second time, the detail below says where.");
  await expect(pane(page)).toContainText("The model stopped after page 5 of 8.");
  await expect(pane(page).locator('img[src="/brand/animations/delphi-warning-alert.gif"]')).toBeVisible();
  await expect(pane(page).getByRole("button")).toHaveText(["Try again"]);

  // It stops a second time: the detail says where.
  await pane(page).getByRole("button", { name: "Try again", exact: true }).click();
  let stream = await nextStream("broken");
  await expect(pane(page).getByRole("heading", { name: "Writing the digest", exact: true })).toBeVisible();
  fail(reader, stream, "The model stopped at page 6 of 8.");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("The model stopped at page 6 of 8.");
  await expect(mark(page)).toHaveAttribute("data-state", "failed");

  await pane(page).getByRole("button", { name: "Try again", exact: true }).click();
  stream = await nextStream("broken");
  finish(reader, stream, "## Survey\n\nThe survey's digest, at last.");
  await expect(pane(page).locator(".digest-document")).toContainText("The survey's digest, at last.");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish" })).toHaveCount(0);
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("a digest that finishes while the reader is on the document pings until it is opened", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "draft-notes");
  await digestButton(page).click();
  await pane(page).getByRole("button", { name: "Generate", exact: true }).click();
  const stream = await nextStream("draft");
  // Back to reading while it is written.
  await documentButton(page).click();
  await expect(pane(page)).toBeHidden();
  await expect(mark(page)).toHaveAttribute("data-state", "preparing");
  expect(await motion(page)).toBe("digest-spin");
  finish(reader, stream, "## Decoding notes\n\nFinished while the reader read.");
  await expect(mark(page)).toHaveAttribute("data-state", "new");
  expect(await tooltip(page)).toBe("Digest just finished");
  expect(await motion(page)).toBe("digest-ping");
  // Still on the document: a finished digest does not take the page box.
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");

  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toContainText("Finished while the reader read.");
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  await documentButton(page).click();
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("with reduced motion the marks hold still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "speculative");
  await expect(mark(page)).toHaveAttribute("data-state", "failed");
  expect(await motion(page)).toBe("none");
  await digestButton(page).click();
  await pane(page).getByRole("button", { name: "Try again", exact: true }).click();
  const stream = await nextStream("broken");
  await documentButton(page).click();
  await expect(mark(page)).toHaveAttribute("data-state", "preparing");
  expect(await motion(page)).toBe("none");
  finish(reader, stream, "## Survey\n\nDone.");
  await expect(mark(page)).toHaveAttribute("data-state", "new");
  expect(await motion(page)).toBe("none");
});

test("opening another document, or the same one again, starts on its Document view", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  await row(page, "Draft notes on decoding").click();
  await expect(page).toHaveURL(/\/draft-notes$/);
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(mark(page)).toHaveAttribute("data-state", "missing");
  await expect(pane(page)).toBeHidden();
  await expect(pager(page)).toHaveText("1 / 8");
  await row(page, "SGLang").click();
  await expect(page).toHaveURL(/\/sglang$/);
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  await expect(pane(page)).toBeHidden();

  // A web page has the same toggle, beside its label and without a title.
  await row(page, "Notes on KV caches").click();
  await expect(page).toHaveURL(/\/kv-cache-post$/);
  await expect(page.locator(".reader-project-label")).toHaveText("Inference systems");
  await expect(page.locator(".reader-heading h1")).toHaveCount(0);
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(mark(page)).toHaveAttribute("data-state", "missing");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "No digest for this document yet", exact: true })).toBeVisible();
  // The page's own ⋮ lies under the digest; the row's end holds one for the digest's text size.
  await page.locator(".reader-heading-menu summary").click();
  await expect(page.getByRole("button", { name: "Larger digest text (⌘+)" })).toBeVisible();
});

test("a page citation in the digest returns to the document at that page", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await expect(pager(page)).toHaveText("1 / 8");
  await digestButton(page).click();
  await pane(page).getByRole("link", { name: "(p. 3)", exact: true }).click();
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pane(page)).toBeHidden();
  await expect(page).toHaveURL(/\/sglang\?focusPage=3$/);
  await expect(pager(page)).toHaveText("3 / 8");
  await expect(page.locator('.pdf-page[data-page="3"]')).toBeInViewport();
});

test("the library's paper menu no longer offers the digest", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  const sglang = page.locator(".paper-row", { has: row(page, "SGLang") });
  await sglang.hover();
  await sglang.getByRole("button", { name: /^Actions for SGLang/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Done", "Rename", "Move project", "Remove document"]);
  await page.keyboard.press("Escape");
  await page.locator(".paper-row", { has: row(page, "Draft notes") }).click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Show digest" })).toHaveCount(0);
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(4);
});

const more = (page: Page) => page.locator(".reader-actions").getByLabel("More", { exact: true });

/** Every header part on screen sits inside the heading and clear of the others. */
async function expectHeaderClear(page: Page) {
  const heading = await box(page.locator(".reader-heading"));
  const parts: [string, Locator][] = [
    ["label", page.locator(".reader-project-label")],
    ["toggle", toggle(page)],
    ["title", page.locator(".reader-heading h1")],
    ...(await page.locator(".reader-actions > *").all()).map((part, index) => [`action ${index}`, part] as [string, Locator]),
  ];
  const shown: [string, Box][] = [];
  for (const [name, part] of parts) {
    if (!(await part.isVisible())) continue;
    const at = await box(part);
    if (!at.width || !at.height) continue;
    expect(inside(at, heading), `${name} inside the heading`).toBe(true);
    shown.push([name, at]);
  }
  for (const [i, [a, first]] of shown.entries()) {
    for (const [b, second] of shown.slice(i + 1)) expect(overlaps(first, second), `${a} clear of ${b}`).toBe(false);
  }
  expect(await page.locator(".reader-heading").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
}

test("a roomy reader shows the whole label and the contents beside the digest", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  const label = await box(page.locator(".reader-project-label"));
  const group = await box(toggle(page));
  expect(label.height).toBe(22);
  expect(group.height).toBe(22);
  expect(Math.round(group.x - label.x - label.width)).toBe(6);
  expect(Math.round((await box(documentButton(page))).width)).toBe(76);
  expect(Math.round((await box(digestButton(page))).width)).toBe(76);
  await expectHeaderClear(page);
  await digestButton(page).click();
  await expect(pane(page).getByRole("navigation", { name: "Contents", exact: true })).toBeVisible();
  await expectHeaderClear(page);
});

const menuRows = (page: Page) => page.locator(".reader-menu-items > :not(hr)").evaluateAll(rows => rows.map(row => row.querySelector(".reader-menu-label")!.textContent));

test("a PDF keeps only the project and Document | Digest on top; its title row holds Notes and ⋮, and ⋮ zooms and exports", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  // The top row has nothing to press but the toggle.
  await expect(page.locator(".reader-heading-row .icon-button")).toHaveCount(0);
  const title = await box(page.locator(".reader-heading h1"));
  const actions = await box(page.locator(".reader-actions"));
  expect(actions.x).toBeGreaterThanOrEqual(title.x + title.width);
  expect(Math.abs(actions.y + actions.height / 2 - (title.y + title.height / 2))).toBeLessThanOrEqual(3);
  expect(await box(more(page))).toMatchObject({ width: 26, height: 26 });

  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["Zoom", "Export PDF"]);
  // Opening ⋮ is not reading on: the library stays where it was.
  await expect(page.locator(".library-collapsed")).toHaveCount(0);
  const exported = page.getByRole("link", { name: "Export PDF", exact: true });
  await expect(exported).toHaveAttribute("href", /\/papers\/sglang\/file\?download=true$/);
  await expect(exported).toHaveAttribute("download", "");
  expect(inside(await box(page.locator(".reader-menu-items")), await box(page.locator(".reader-panel")))).toBe(true);
  // Zooming leaves the menu open; the readout returns to 100%.
  await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".reader-menu-zoom-value")).toHaveText("130%");
  await page.locator(".reader-menu-zoom-value").click();
  await expect(page.locator(".reader-menu-zoom-value")).toHaveText("100%");
  // The reset disabled itself under focus; Escape still closes, and ⋮ takes focus back.
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-menu-items")).toBeHidden();
  await expect(more(page)).toBeFocused();
  await more(page).click();
  // A click anywhere else puts it away.
  await page.locator(".reader-heading h1").click();
  await expect(page.locator(".reader-menu-items")).toBeHidden();

  // Under the digest, Notes goes and ⋮ keeps Export, its Zoom now the digest's.
  await digestButton(page).click();
  await expect(pane(page)).toBeVisible();
  await expect(page.locator(".reader-annotation-slot")).toBeHidden();
  await more(page).click();
  await expect.poll(() => menuRows(page)).toEqual(["Zoom", "Export PDF"]);
  await expect(page.getByRole("button", { name: "Larger digest text (⌘+)" })).toBeVisible();
  await expectHeaderClear(page);
});

test("with highlights and their notes, ⋮ exports the annotated PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  reader.annotations.highlights = [{ id: "h1", type: "pdf", page: 2, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }], text: "RadixAttention", color: "amber" }];
  // The backend writes each note into its highlight's comment (core test_projects).
  reader.annotations.notes = [{ id: "n1", highlightId: "h1", page: 2, anchorY: 0.2, quotedText: "RadixAttention", body: "Why it matters", createdAt: "now", updatedAt: "now", filedAt: null } as Note];
  await openReader(page, reader, "sglang");
  await more(page).click();
  const exported = page.getByRole("link", { name: "Export annotated PDF", exact: true });
  await expect(exported).toHaveAttribute("href", /download=true&annotated=true$/);
  await expect(page.getByRole("link", { name: "Export PDF", exact: true })).toHaveCount(0);
});

/** The library at its widest in a 900px window: the reader is squeezed to its 372px floor. */
async function squeeze(page: Page) {
  await page.getByRole("separator", { name: "Resize paper library" }).press("End");
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "Expand library", exact: true }).click();
  await expect.poll(() => page.locator(".reader-panel").evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(372);
}

test("at the narrowest reader column the header stays clear and the label keeps its name", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 700 });
  await openReader(page, library(), "sglang");
  await squeeze(page);
  // The actions left the label's row, so the name stays readable.
  const label = page.locator(".reader-project-label");
  await expect(label).toHaveText("Inference systems");
  await expect(label).toHaveAttribute("title", "Inference systems");
  expect(Math.round((await box(documentButton(page))).width)).toBe(62);
  expect(Math.round((await box(digestButton(page))).width)).toBe(62);
  expect(await page.locator(".reader-actions").evaluate(node => getComputedStyle(node).columnGap)).toBe("4px");
  await expectHeaderClear(page);
  await more(page).click();
  expect(inside(await box(page.locator(".reader-menu-items")), await box(page.locator(".reader-panel")))).toBe(true);
  await page.keyboard.press("Escape");

  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  await expect(pane(page).getByRole("navigation", { name: "Contents", exact: true })).toBeHidden();
  await expectHeaderClear(page);
  expect(await pane(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator(".digest-reading-scroll").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const footer = await box(pane(page).locator(".digest-footer"));
  expect(inside(footer, await box(pane(page)))).toBe(true);
  expect(inside(await box(pane(page).getByRole("button", { name: "Regenerate digest", exact: true })), footer)).toBe(true);
});

test("Regenerate in the footer replaces the digest, and a failed one keeps it and says why", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "sglang");
  await digestButton(page).click();
  const footer = pane(page).locator(".digest-footer");
  const regenerate = footer.getByRole("button", { name: "Regenerate digest", exact: true });
  await expect(footer).toContainText(`${modelLabel(model)} · Oct 26`);
  await expect(regenerate).toHaveText("Regenerate");

  await regenerate.click();
  let stream = await nextStream("sglang");
  expect(stream.force).toBe(true);
  await expect(regenerate).toHaveText("Regenerating…");
  await expect(regenerate).toBeDisabled();
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  stream.send({ type: "progress", message: "Reading pages 1–8" });
  finish(reader, stream, "## Updated overview\n\nA regenerated digest.\n\n### New section\n\nNew body.");
  await expect(pane(page).locator(".digest-document")).toContainText("A regenerated digest");
  await expect(pane(page).locator(".digest-document")).not.toContainText("language-model programs");
  await expect(pane(page).getByRole("navigation", { name: "Contents" }).getByRole("link", { name: "New section" })).toBeVisible();
  await expect(footer).toContainText(`${modelLabel(model)} · Oct 29`);
  await expect(regenerate).toHaveText("Regenerate");
  await expect(regenerate).toBeEnabled();

  await regenerate.click();
  stream = await nextStream("sglang");
  fail(reader, stream, "The model stopped at page 4 of 8.");
  await expect(footer.getByRole("alert")).toContainText("The model stopped at page 4 of 8.");
  await expect(pane(page).locator(".digest-document")).toContainText("A regenerated digest");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish" })).toHaveCount(0);
  await expect(regenerate).toBeEnabled();
  // The stored digest is still the document's digest.
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("a citation to the open document, from its chat or its address, brings the document back at that page", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  const conversation = "1".repeat(32);
  reader.routes["/api/chat/conversations"] = { items: [{ id: conversation, generation: 0, title: "Runtime", empty: false, manualTitle: false }], defaultId: conversation, limit: 10 };
  reader.routes["/api/chat"] = { conversationId: conversation, images: [], messages: [
    { role: "user", content: "Where is the runtime described?", createdAt: "2026-10-29T09:00:00Z", requestId: "r1" },
    { role: "assistant", content: "The runtime and its cache are laid out together (p. 5).", createdAt: "2026-10-29T09:00:05Z", requestId: "r1" },
  ] };
  await openReader(page, reader, "sglang", "?chat=paper");
  await expect(pager(page)).toHaveText("1 / 8");
  // From the chat beside the digest.
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  await page.locator(".citation-link", { hasText: "p. 5" }).click();
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pane(page)).toBeHidden();
  await expect(pager(page)).toHaveText("5 / 8");
  await expect(page.locator('.pdf-page[data-page="5"]')).toBeInViewport();

  // From the address: forward again to a page the digest cited, with the chat still open beside it.
  await digestButton(page).click();
  await pane(page).getByRole("link", { name: "(p. 3)", exact: true }).click();
  const address = () => Object.fromEntries(new URL(page.url()).searchParams);
  await expect.poll(address).toEqual({ chat: "paper", conversation, focusPage: "3" });
  await expect(page.locator(".chat-surface")).toHaveCount(1);
  await expect(pager(page)).toHaveText("3 / 8");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("focusPage")).toBeNull();
  await page.locator(".pdf-scroll").evaluate(node => node.scrollTo({ top: node.scrollHeight }));
  await expect(pager(page)).toHaveText("8 / 8");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  await page.goForward();
  await expect.poll(address).toEqual({ chat: "paper", conversation, focusPage: "3" });
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pane(page)).toBeHidden();
  await expect(pager(page)).toHaveText("3 / 8");
});

test("a stored digest outlives a regenerate that failed or is still running when the reader leaves and returns", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "sglang");
  const regenerate = pane(page).getByRole("button", { name: "Regenerate digest", exact: true });
  const away = async () => {
    await row(page, "Draft notes on decoding").click();
    await expect(page).toHaveURL(/\/draft-notes$/);
    await row(page, "SGLang").click();
    await expect(page).toHaveURL(/\/sglang$/);
  };

  await digestButton(page).click();
  await regenerate.click();
  fail(reader, await nextStream("sglang"), "The model stopped at page 4 of 8.");
  await expect(pane(page).locator(".digest-footer").getByRole("alert")).toContainText("The model stopped at page 4 of 8.");
  await away();
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish" })).toHaveCount(0);
  await expect(regenerate).toBeEnabled();

  await regenerate.click();
  const stream = await nextStream("sglang");
  await away();
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  await expect(pane(page).getByRole("heading", { name: "Writing the digest" })).toHaveCount(0);
  await expect(regenerate).toHaveText("Regenerating…");
  await expect(regenerate).toBeDisabled();
  finish(reader, stream, "## Updated overview\n\nA regenerated digest.");
  await expect(pane(page).locator(".digest-document")).toContainText("A regenerated digest");
  await expect(regenerate).toBeEnabled();
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("a digest the library lists but the store no longer holds offers Generate, and the mark follows the store", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  reader.served.sglang = { paper: { ...reader.project.papers[0], digest: { status: "missing" } }, digest: null };
  await openReader(page, reader, "sglang");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "No digest for this document yet", exact: true })).toBeVisible();
  await expect(pane(page).getByRole("button")).toHaveText(["Generate"]);
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish" })).toHaveCount(0);
  // The toggle believes the store, not the library's stale listing.
  await expect(mark(page)).toHaveAttribute("data-state", "missing");
  await pane(page).getByRole("button", { name: "Generate", exact: true }).click();
  fail(reader, await nextStream("sglang"), "The model stopped at page 2 of 8.");
  await expect(pane(page).getByRole("heading", { name: "The digest didn't finish", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("The model stopped at page 2 of 8.");
  await expect(mark(page)).toHaveAttribute("data-state", "failed");
});

test("focus follows the reader: back to the document from a citation, and onto the pane from Generate", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  const focused = () => page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    if (active.closest(".reader-view-toggle")) return `toggle ${active.textContent}`;
    if (active.closest(".reader-document")) return "document";
    if (active.closest('section[aria-label="Digest"]')) return "digest";
    return active.outerHTML.slice(0, 80);
  });
  await digestButton(page).click();
  await pane(page).getByRole("link", { name: "(p. 3)", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pager(page)).toHaveText("3 / 8");
  expect(["toggle Document", "document"]).toContain(await focused());

  await row(page, "Draft notes on decoding").click();
  await digestButton(page).click();
  await pane(page).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(pane(page).getByRole("heading", { name: "Writing the digest", exact: true })).toBeVisible();
  expect(await focused()).toBe("digest");
});

test("a focused citation stays the same element through a resize", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await digestButton(page).click();
  const citation = pane(page).getByRole("link", { name: "(p. 3)", exact: true });
  await citation.focus();
  const held = (await citation.elementHandle())!;
  await page.setViewportSize({ width: 1560, height: 880 });
  // Long enough for the window's resize to reach every column.
  await page.waitForTimeout(600);
  expect(await held.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
});

test("the note editor's save hint answers to its own card's width, at any reader width", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 700 });
  const reader = library();
  const text = "Page 1 of the document.";
  reader.annotations = {
    highlights: [{ id: "h1", type: "pdf", page: 1, color: "amber", text, rects: [{ x: 0.1, y: 0.09, w: 0.5, h: 0.04 }] } as Highlight],
    notes: [{ id: "n1", highlightId: "h1", page: 1, anchorY: 0.09, quotedText: text, body: "A first thought", createdAt: "now", updatedAt: "now", filedAt: null } as Note],
  };
  await openReader(page, reader, "sglang");
  const card = page.getByRole("dialog", { name: "Note", exact: true });
  const editNote = async () => {
    await page.getByRole("button", { name: "Annotations (1)", exact: true }).click();
    const popover = page.getByRole("region", { name: "Highlights and notes", exact: true });
    await expect(popover).toContainText("A first thought");
    // From the keyboard: at the narrowest reader the popover is wider than the column.
    await popover.getByRole("button", { name: "Edit note", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(card.locator(".note-save-hint")).toHaveCount(1);
  };
  await editNote();
  await expect(card.locator(".note-save-hint")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // The header's own narrow query must not reach it: only the card's width decides.
  await squeeze(page);
  await editNote();
  const width = await page.locator(".pdf-note-open").evaluate(node => node.getBoundingClientRect().width);
  if (width > 350) await expect(card.locator(".note-save-hint")).toBeVisible();
  else await expect(card.locator(".note-save-hint")).toBeHidden();
  expect(await page.locator(".note-save-hint").evaluate(node => {
    for (let at = node.parentElement; at; at = at.parentElement) if (getComputedStyle(at).containerName.includes("note")) return at.className;
    return "";
  })).toContain("pdf-note-open");
});

test("while the digest is shown, the zoom keys size its text and leave the document alone", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  const zoom = page.locator(".reader-menu-zoom-value");
  await more(page).click();
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("Escape");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  const toc = pane(page).locator(".digest-toc a").first();
  const before = (await toc.boundingBox())!.height;
  // What the app's menu sends for Cmd+=.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: 1 })));
  await more(page).click();
  await expect(zoom).toHaveText("110%");
  // The contents grow with the text, and stay shown.
  expect((await toc.boundingBox())!.height).toBeCloseTo(before * 1.1, 0);
  await page.getByRole("button", { name: "Smaller digest text (⌘−)" }).click();
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: 1 })));
  await documentButton(page).click();
  await more(page).click();
  await expect(zoom).toHaveText("100%");
});

test("the zoom keys size whichever side was pressed last, the chat or the document, and each keeps its own", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang", "?chat=paper");
  const zoomKey = (direction: number) => page.evaluate(direction => window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: direction })), direction);
  const chatZoom = () => page.locator(".chat-surface").evaluate(surface => getComputedStyle(surface).getPropertyValue("--chat-zoom"));
  const documentZoom = async () => {
    await more(page).click();
    const value = await page.locator(".reader-menu-zoom-value").textContent();
    await page.keyboard.press("Escape");
    return value;
  };
  await page.locator(".chat-surface .messages").click({ position: { x: 8, y: 8 } });
  await zoomKey(1);
  await expect.poll(chatZoom).toBe("1.1");
  expect(await documentZoom()).toBe("100%");
  // ⋮ was a press on the document's side: the keys are the document's now.
  await zoomKey(1);
  expect(await documentZoom()).toBe("115%");
  expect(await chatZoom()).toBe("1.1");
  await page.locator(".chat-surface .messages").click({ position: { x: 8, y: 8 } });
  await zoomKey(0);
  await expect.poll(chatZoom).toBe("1");
  expect(await documentZoom()).toBe("115%");
});

test("while the digest is shown, Find never opens out of sight", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("delphi-reader-find")));
  // Find is the document's, so it brings the document back and opens there.
  await expect(documentButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pane(page)).toBeHidden();
  const find = page.getByRole("textbox", { name: "Find in document", exact: true });
  await expect(find).toBeVisible();
  await expect(find).toBeFocused();
});

test("while filing writes the digest, Generate waits, and the digest opens the moment filing finishes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  const filing = { filed: false, queued: true, stuck: false, stale: false, dropped: [], filedVersion: null, version: "v" };
  reader.routes["/api/config"] = { ...DEFAULT_APP_CONFIG, webDocumentsEnabled: true, memoryEnabled: true };
  reader.routes["/api/memory/documents/draft/filing"] = filing;
  reader.routes["/api/memory/maintenance"] = { pending: 1, leased: 0, cancellable: 1, failed: 0, due: 1, jobs: [], maxAttempts: 3 };
  // Nothing this tab can claim yet: another drain holds the job.
  await page.route("**/api/memory/maintenance/drain", route => route.fulfill({ contentType: "text/event-stream",
    body: 'data: {"type":"done","claimed":false}\n\n' }));
  await openReader(page, reader, "draft-notes");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "The digest is on its way", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("Filing this document into Memory writes its digest.");
  // A digest written now would be written again by the filing: the press does nothing.
  const pending = pane(page).getByRole("button", { name: "Generation pending", exact: true });
  await expect(pending).toHaveAttribute("aria-disabled", "true");
  await pending.click({ force: true });
  await expect(pane(page).getByRole("heading", { name: "The digest is on its way", exact: true })).toBeVisible();
  expect(streams).toHaveLength(0);

  // This tab's drain files it: the reader stays on the Digest tab and the digest arrives there.
  const draft = reader.project.papers.find(item => item.id === "draft")!;
  draft.digest = { status: "ready", model, updatedAt: "2026-10-29T10:00:00Z" };
  reader.digests.draft = { paper: draft, digest: { contentMarkdown: "## Decoding notes\n\nWritten by the filing.", citations: [], assets: [] } };
  reader.routes["/api/memory/documents/draft/filing"] = { ...filing, filed: true, queued: false };
  await page.unroute("**/api/memory/maintenance/drain");
  let claims = 0;
  await page.route("**/api/memory/maintenance/drain", route => route.fulfill({ contentType: "text/event-stream",
    body: claims++ ? 'data: {"type":"done","claimed":false}\n\n'
      : 'data: {"type":"progress","jobId":"job-1","message":"Reading the document"}\n\ndata: {"type":"done","jobId":"job-1","claimed":true}\n\n' }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pane(page).locator(".digest-document")).toContainText("Written by the filing.");
});

test("a filing that failed an attempt no longer holds Generate back", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  reader.routes["/api/config"] = { ...DEFAULT_APP_CONFIG, webDocumentsEnabled: true, memoryEnabled: true };
  reader.routes["/api/memory/documents/draft/filing"] = { filed: false, queued: true, stuck: false, stale: false, dropped: [], filedVersion: null, version: "v" };
  // Waiting out its retry, which may be minutes away or never come.
  reader.routes["/api/memory/maintenance"] = { pending: 1, leased: 0, cancellable: 1, failed: 0, due: 0, maxAttempts: 3, jobs: [{
    id: "job-1", kind: "document", marker: "paper:draft", payload: { paperId: "draft" }, status: "pending", attempts: 1,
    leaseExpiresAt: null, retryAt: "2026-11-03T20:00:00Z", lastError: "Provider unavailable", createdAt: "2026-11-03T19:00:00Z", updatedAt: "2026-11-03T19:01:00Z",
  }] };
  await page.route("**/api/memory/maintenance/drain", route => route.fulfill({ contentType: "text/event-stream",
    body: 'data: {"type":"done","claimed":false}\n\n' }));
  await openReader(page, reader, "draft-notes");
  await digestButton(page).click();
  await expect(pane(page).getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});

test("a page whose rest is still being read waits to offer Generate, and offers it once the capture lands", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  const web = reader.project.papers.find(item => item.id === "web")!;
  web.capture = "partial";
  await openReader(page, reader, "kv-cache-post");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "The digest is on its way", exact: true })).toBeVisible();
  await expect(pane(page)).toContainText("Delphi is still reading the rest of this page.");
  await expect(pane(page).getByRole("button", { name: "Generation pending", exact: true })).toHaveAttribute("aria-disabled", "true");
});

test("a digest the backend finishes, seen on a reload while the reader is on the document, pings", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "paged-attention");
  await expect(mark(page)).toHaveAttribute("data-state", "preparing");
  // Written meanwhile; the reader's next change to the library reloads it.
  const paged = reader.project.papers.find(item => item.id === "pending")!;
  paged.digest = { status: "ready", model, updatedAt: "2026-10-29T10:00:00Z" };
  reader.digests.pending = { paper: paged, digest: { contentMarkdown: "## Paging\n\nWritten by the backend.", citations: [], assets: [] } };
  const draft = page.locator(".paper-row", { has: row(page, "Draft notes") });
  await draft.hover();
  await draft.getByRole("button", { name: /^Actions for Draft notes/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(mark(page)).toHaveAttribute("data-state", "new");
  expect(await motion(page)).toBe("digest-ping");
  await digestButton(page).click();
  await expect(pane(page).locator(".digest-document")).toContainText("Written by the backend.");
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  // A digest that was ready when the library loaded has nothing new to say.
  await row(page, "SGLang").click();
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
});

test("the digest scrolls from the keyboard once the reader has clicked into it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  await digestButton(page).click();
  const scroller = pane(page).locator(".digest-reading-scroll");
  const top = () => scroller.evaluate(node => node.scrollTop);
  /** Back at the top and still: WebKit drops a key pressed while a smooth scroll is moving. */
  const atRest = async () => {
    await scroller.evaluate(node => node.scrollTo({ top: 0 }));
    let last = -1;
    await expect.poll(async () => { const now = await top(); const still = now === last; last = now; return still; }).toBe(true);
  };
  await pane(page).locator(".digest-document p").first().click();
  await expect(scroller).toBeFocused();
  for (const key of ["PageDown", "Space"]) {
    await atRest();
    await page.keyboard.press(key);
    await expect.poll(top, { message: `${key} scrolls the digest` }).toBeGreaterThan(0);
  }
  // Blank space in the contents list is part of the digest too.
  await atRest();
  const contents = pane(page).getByRole("navigation", { name: "Contents", exact: true });
  const list = await box(contents);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 4);
  await expect(scroller).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(top, { message: "Space scrolls the digest" }).toBeGreaterThan(0);
});

test("Regenerate from the keyboard keeps focus where the reader left it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  await openReader(page, reader, "sglang");
  await digestButton(page).click();
  const regenerate = pane(page).getByRole("button", { name: "Regenerate digest", exact: true });
  const where = () => page.evaluate(() => document.activeElement === document.body ? "body"
    : document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  await regenerate.focus();
  await page.keyboard.press("Enter");
  const stream = await nextStream("sglang");
  await expect(regenerate).toBeDisabled();
  expect(await where()).not.toBe("body");
  finish(reader, stream, "## Updated overview\n\nA regenerated digest.");
  await expect(pane(page).locator(".digest-document")).toContainText("A regenerated digest");
  await expect(regenerate).toBeEnabled();
  expect(await where()).toBe("Regenerate digest");
});

test("the same search hit, picked again from the digest, returns to the document at its page", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  reader.routes["/api/search"] = { query: "radix", results: { memory: [], conversations: [], documents: [{
    kind: "document", title: "SGLang", subtitle: "Inference systems · p. 6", snippet: "RadixAttention reuses the KV cache.", score: 1, occurrences: 1,
    paperId: "sglang", paperSlug: "sglang", projectId: "project", projectSlug: "inference", documentKind: "pdf", locator: "6", locatorKind: "page",
  }] } };
  await openReader(page, reader, "sglang");
  const pick = async () => {
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "Search Delphi" });
    const input = search.getByRole("textbox", { name: "Search pages, documents and chats" });
    // The box clears itself just after it opens; typing before that would be wiped.
    await expect(input).toHaveValue("");
    await input.fill("radix");
    await search.locator(".search-result-title", { hasText: "SGLang" }).click();
    await expect(search).toBeHidden();
  };
  for (const time of ["first", "second"]) {
    // The last jump may still be settling its page; scroll back up once it has.
    await expect(async () => {
      await page.locator(".pdf-scroll").evaluate(node => node.scrollTo({ top: 0 }));
      await expect(pager(page)).toHaveText("1 / 8", { timeout: 1000 });
    }).toPass();
    await digestButton(page).click();
    await expect(pane(page).locator(".digest-document")).toBeVisible();
    await pick();
    await expect(page, `${time} pick`).toHaveURL(/\/sglang\?focusPage=6$/);
    await expect(documentButton(page), `${time} pick`).toHaveAttribute("aria-pressed", "true");
    await expect(pane(page)).toBeHidden();
    await expect(pager(page), `${time} pick`).toHaveText("6 / 8");
  }
});

test("a stored digest that doesn't load says so, and Try again reads it and hands it the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReader(page, library(), "sglang");
  // Registered after the reader's routes, so it answers first.
  let refusals = 1;
  await page.route("**/api/projects/project/papers/sglang/digest", route => refusals-- > 0
    ? route.fulfill({ status: 503, json: { detail: "The library is busy" } }) : route.fallback());
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "Couldn't open the digest", exact: true })).toBeVisible();
  await expect(pane(page).locator(".digest-state-detail")).toContainText("The library is busy");
  await expect(mark(page)).toHaveAttribute("data-state", "ready");
  await pane(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pane(page).locator(".digest-document")).toContainText("language-model programs");
  await expect(pane(page).locator(".digest-reading-scroll")).toBeFocused();
});

test("a stored digest the store can't give back is built again", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reader = library();
  const sglang = reader.project.papers[0];
  reader.served.sglang = { paper: sglang, digest: null };
  await openReader(page, reader, "sglang");
  await digestButton(page).click();
  await expect(pane(page).getByRole("heading", { name: "Couldn't open the digest", exact: true })).toBeVisible();
  delete reader.served.sglang;
  await pane(page).getByRole("button", { name: "Generate again", exact: true }).click();
  const stream = await nextStream("sglang");
  expect(stream.force).toBe(true);
  finish(reader, stream, "## Rebuilt\n\nBuilt again from the document.");
  await expect(pane(page).locator(".digest-document")).toContainText("Built again from the document.");
});
