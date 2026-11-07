import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";
import { samplePdf } from "../../../tests/fixtures/pdf.mts";

// Removing a document against the installed backend: the library, the delete
// and the address are real.
type Workspace = Awaited<ReturnType<typeof subscriptionWorkspace>>;
type Paper = { id: string; slug: string; title: string };
let workspace: Workspace;
test.use({ actionTimeout: 10_000, viewport: { width: 1600, height: 900 } });
test.beforeEach(async ({ context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
});
test.afterEach(async () => { await workspace?.close(); });

async function seed(w: Workspace, names: string[], name = "Removals") {
  const project = await (await w.request("/api/projects", { name })).json() as { id: string; slug: string; name: string };
  const papers: Paper[] = [];
  for (const name of names) {
    const form = new FormData();
    form.append("file", new Blob([samplePdf()], { type: "application/pdf" }), name);
    const upload = await fetch(`${w.origin}/api/projects/${project.id}/papers`, { method: "POST", headers: { cookie: w.cookie, origin: w.origin }, body: form });
    expect(upload.ok).toBe(true);
    papers.push(await upload.json() as Paper);
  }
  const at = (paper: Paper) => `/@workflow/${project.slug}/${paper.slug}`;
  return { project, papers, at };
}

async function remove(page: import("@playwright/test").Page, paper: Paper) {
  await page.getByRole("button", { name: `Actions for ${paper.title}` }).click();
  await page.getByRole("menuitem", { name: "Remove document" }).click();
  await page.getByRole("button", { name: "Delete document" }).click();
}

test("removing the open document opens the project's first remaining one", async ({ page }) => {
  test.setTimeout(90_000);
  const { papers: [first, second, third], at } = await seed(workspace, ["First.pdf", "Second.pdf", "Third.pdf"]);
  await page.goto(`${workspace.origin}${at(second)}?chat=general`);
  await expect(page.getByRole("button", { name: `Actions for ${second.title}` })).toBeVisible();

  // The docked chat stays docked on the document the reader lands on.
  await remove(page, second);
  await expect(page).toHaveURL(new RegExp(`${at(first)}\\?chat=general`));
  await expect(page.locator(".chat-surface")).toBeVisible();
  await expect(page.getByText("Nothing to read in")).toHaveCount(0);

  // Removing one the reader is not on leaves them where they are.
  await remove(page, third);
  await expect(page.getByRole("button", { name: `Actions for ${third.title}` })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${at(first)}\\?chat=general`));

  // The last one leaves the project's own, empty, page.
  await remove(page, first);
  await expect(page.getByText("Nothing to read in")).toBeVisible();
});

const python = () => fileURLToPath(new URL("../../../.delphi-build/python/bin/python3", import.meta.url));

/** Every Memory page's slug, read through the bundled store. */
function memorySlugs(w: Workspace): string[] {
  const script = `import json, sys
from delphi_core.config import Settings
from delphi_core.storage import LocalStorage
s = LocalStorage(Settings(_env_file=None, data_dir=sys.argv[1]))
print(json.dumps([page["slug"] for page in s.list_memory_pages("workflow", limit=500)]))
`;
  const run = spawnSync(python(), ["-I", "-c", script, join(w.dir, "data")], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string[];
}

/** Memory pages written from `paperId`, as a filing would leave them, through the bundled store. */
function fileFrom(w: Workspace, paperId: string, pages: Array<{ slug: string; kind: "source" | "concept"; cites: string[]; body?: string }>) {
  const script = `import json, sys
from delphi_core.config import Settings
from delphi_core.storage import LocalStorage
s = LocalStorage(Settings(_env_file=None, data_dir=sys.argv[1]))
for page in json.loads(sys.argv[2]):
    citations = [dict(id=i, claimType="author-claim", paperId=cited, page=1) for i, cited in enumerate(page["cites"], 1)]
    s.upsert_memory_page("workflow", dict(kind=page["kind"], slug=page["slug"], title=page["slug"].replace("-", " ").capitalize(), domain="ml",
        summary="Filed.", body=page.get("body") or " ".join(f"A claim [E{i}]." for i in range(1, len(citations) + 1)) or "Filed.",
        citations=citations, sourcePaperId=sys.argv[3]), max_pages=50)
`;
  const run = spawnSync(python(), ["-I", "-c", script, join(w.dir, "data"), JSON.stringify(pages), paperId], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
}

test("deleting a document offers the Memory pages that stand on it alone, and removes only the ticked ones", async ({ page }) => {
  test.setTimeout(90_000);
  const { papers: [paper], at } = await seed(workspace, ["Cited.pdf"]);
  fileFrom(workspace, paper.id, [
    { slug: "its-own-page", kind: "source", cites: [] },
    { slug: "only-from-it", kind: "concept", cites: [paper.id] },
    { slug: "kept-by-the-reader", kind: "concept", cites: [paper.id] },
    { slug: "also-another", kind: "concept", cites: [paper.id, "elsewhere"] },
  ]);
  // The offer is held back: Delete waits for it, or a quick press would leave its pages behind.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname.endsWith("/dependents"), async (route) => { await held; await route.continue(); });
  await page.goto(`${workspace.origin}${at(paper)}`);
  await page.getByRole("button", { name: `Actions for ${paper.title}` }).click();
  await page.getByRole("menuitem", { name: "Remove document" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Delete document" })).toBeDisabled();
  release();
  // Its source page first, then each concept that cites nothing else; one that
  // also cites another document is not offered.
  const offered = dialog.locator(".plan-capacity-row strong");
  await expect(offered).toHaveCount(3);
  await expect(offered.first()).toHaveText("Its own page");
  expect((await offered.allTextContents()).sort()).toEqual(["Its own page", "Kept by the reader", "Only from it"]);
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await dialog.getByRole("checkbox", { name: /Kept by the reader/ }).uncheck();
  await dialog.getByRole("button", { name: "Delete document and 2 pages" }).click();
  await expect(page.getByRole("button", { name: `Actions for ${paper.title}` })).toHaveCount(0);

  const seeded = ["its-own-page", "only-from-it", "kept-by-the-reader", "also-another"];
  await expect.poll(() => memorySlugs(workspace).filter((slug) => seeded.includes(slug)).sort())
    .toEqual(["also-another", "kept-by-the-reader"]);
});

test("a chat beside another document stops linking a page that went with a deleted document", async ({ page }) => {
  test.setTimeout(90_000);
  const { papers: [reading, removed], at } = await seed(workspace, ["Reading.pdf", "Removed.pdf"]);
  fileFrom(workspace, removed.id, [{ slug: "only-from-it", kind: "concept", cites: [removed.id] }]);
  // An answer beside the document being read names that page.
  const script = `import sys
from delphi_core.config import Settings
from delphi_core.storage import LocalStorage
from delphi_core.storage.conversations import selector
s = LocalStorage(Settings(_env_file=None, data_dir=sys.argv[1]))
project = next(p for p in s.list_projects_with_papers("workflow") if any(x["id"] == sys.argv[2] for x in p["papers"]))
item = s.create_conversation("workflow", "document", project["id"], sys.argv[2], "t_named_page")
key = selector(item["id"], item["generation"])
s.append_message("workflow", project["id"], key, dict(role="user", content="What does this build on?", requestId="r1"))
s.append_message("workflow", project["id"], key, dict(role="assistant", content="It builds on [[only-from-it]].", requestId="r1"))
`;
  const run = spawnSync(python(), ["-I", "-c", script, join(workspace.dir, "data"), reading.id], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  await page.goto(`${workspace.origin}${at(reading)}?chat=paper`);
  const turn = page.locator(".kb-chat-turn").last();
  await expect(turn.locator("a.kb-link")).toHaveText("Only from it");

  await page.getByRole("button", { name: `Actions for ${removed.title}` }).click();
  await page.getByRole("menuitem", { name: "Remove document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete document and 1 page" }).click();
  await expect(turn).toContainText("It builds on only from it.");
  await expect(turn.locator("a.kb-link")).toHaveCount(0);
});

test("a source page kept when its document went deletes from Memory later, and the links to it become words", async ({ page }) => {
  test.setTimeout(90_000);
  const { papers: [left, staying], at } = await seed(workspace, ["Left.pdf", "Staying.pdf"]);
  fileFrom(workspace, left.id, [{ slug: "left-behind", kind: "source", cites: [] }]);
  fileFrom(workspace, staying.id, [{ slug: "builds-on-it", kind: "concept", cites: [staying.id], body: "Builds on [[left-behind]] [E1]." }]);

  // The reader keeps the page when the document goes.
  await page.goto(`${workspace.origin}${at(left)}`);
  await page.getByRole("button", { name: `Actions for ${left.title}` }).click();
  await page.getByRole("menuitem", { name: "Remove document" }).click();
  const removing = page.getByRole("alertdialog");
  await removing.getByRole("checkbox", { name: /Left behind/ }).uncheck();
  await removing.getByRole("button", { name: "Delete document", exact: true }).click();
  await expect(page.getByRole("button", { name: `Actions for ${left.title}` })).toHaveCount(0);

  // Later, from a page that links to it.
  await page.goto(`${workspace.origin}/memory?page=builds-on-it`);
  await page.locator(".kb-prose").getByRole("link", { name: "Left behind" }).click();
  const meta = page.locator(".kb-page-meta");
  await expect(meta.getByRole("button", { name: "Open document" })).toHaveCount(0);
  await meta.getByRole("button", { name: "Delete page (document removed)" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete page?" });
  await expect(dialog).toContainText("Links to it on 1 page become plain words.");
  await dialog.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(page).toHaveURL(/\/memory\/graph\?domain=ml/);
  await expect.poll(() => memorySlugs(workspace).filter((slug) => ["left-behind", "builds-on-it"].includes(slug)))
    .toEqual(["builds-on-it"]);

  await page.goto(`${workspace.origin}/memory?page=builds-on-it`);
  await expect(page.locator(".kb-prose")).toContainText("Builds on Left behind");
  await expect(page.locator(".kb-prose").getByRole("link", { name: "Left behind" })).toHaveCount(0);
});

async function removeProject(page: import("@playwright/test").Page, name: string) {
  // The project switch and the project's row in the library both open its menu.
  await page.getByRole("button", { name: `Actions for ${name}` }).first().click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  return page.getByRole("alertdialog");
}

test("deleting a project offers the pages that stand on its documents alone, together, and removes only the ticked ones", async ({ page }) => {
  test.setTimeout(120_000);
  const { project, papers: [first, second], at } = await seed(workspace, ["First.pdf", "Second.pdf"], "Diffusion");
  const { papers: [outside] } = await seed(workspace, ["Outside.pdf"], "Elsewhere");
  fileFrom(workspace, first.id, [
    { slug: "first-page", kind: "source", cites: [] },
    { slug: "only-the-first", kind: "concept", cites: [first.id] },
    // Neither document's own delete offers this one; the project's does.
    { slug: "both-of-them", kind: "concept", cites: [first.id, second.id] },
    { slug: "also-outside", kind: "concept", cites: [first.id, outside.id] },
  ]);
  fileFrom(workspace, second.id, [
    { slug: "second-page", kind: "source", cites: [] },
    { slug: "kept-by-the-reader", kind: "concept", cites: [second.id] },
  ]);
  fileFrom(workspace, outside.id, [
    { slug: "outside-page", kind: "source", cites: [] },
    { slug: "written-outside", kind: "concept", cites: [first.id] },
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname.endsWith("/dependents"), async (route) => { await held; await route.continue(); });
  await page.goto(`${workspace.origin}${at(first)}`);

  const dialog = await removeProject(page, project.name);
  await expect(dialog.getByText("Deletes all project contents. Cannot be undone.")).toBeVisible();
  // Delete waits for the offer, or a quick press would leave its pages behind.
  await expect(dialog.getByRole("button", { name: "Delete project" })).toBeDisabled();
  release();
  const offered = dialog.locator(".plan-capacity-row strong");
  await expect(offered).toHaveCount(5);
  // The documents' own pages first, in the library's order.
  expect((await offered.allTextContents()).slice(0, 2)).toEqual(["First page", "Second page"]);
  expect((await offered.allTextContents()).slice(2).sort()).toEqual(["Both of them", "Kept by the reader", "Only the first"]);
  await expect(dialog.locator(".plan-capacity-row small").first()).toHaveText("Source page");
  await expect(dialog.getByText("Cites only this project")).toHaveCount(3);
  await expect(dialog.getByText("Pages that also cite documents outside this project stay.", { exact: false })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Kept by the reader/ }).uncheck();
  await expect(dialog.getByRole("button", { name: "Delete project and 5 pages" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Delete project and 4 pages" }).click();
  await expect(page.getByRole("button", { name: `Actions for ${project.name}` })).toHaveCount(0);

  const seeded = ["first-page", "only-the-first", "both-of-them", "also-outside", "second-page", "kept-by-the-reader", "outside-page", "written-outside"];
  await expect.poll(() => memorySlugs(workspace).filter((slug) => seeded.includes(slug)).sort())
    .toEqual(["also-outside", "kept-by-the-reader", "outside-page", "written-outside"]);
});

test("a project with nothing in Memory, or whose offer cannot be read, deletes as before", async ({ page }) => {
  test.setTimeout(90_000);
  const quiet = await seed(workspace, ["Quiet paper.pdf"], "Quiet");
  const unread = await seed(workspace, ["Unread paper.pdf"], "Unread");
  fileFrom(workspace, unread.papers[0].id, [{ slug: "unread-page", kind: "source", cites: [] }]);
  await page.goto(`${workspace.origin}${quiet.at(quiet.papers[0])}`);

  let dialog = await removeProject(page, "Quiet");
  await expect(dialog.getByRole("button", { name: "Delete project" })).toBeEnabled();
  await expect(dialog.getByText("Also remove from Memory")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("button", { name: "Actions for Quiet" })).toHaveCount(0);

  // A failed read offers nothing, and the delete still goes ahead; the page stays.
  await page.route((url) => url.pathname.endsWith("/dependents"), (route) => route.fulfill({ status: 500, body: "{}" }));
  dialog = await removeProject(page, "Unread");
  await expect(dialog.getByRole("button", { name: "Delete project" })).toBeEnabled();
  await expect(dialog.getByText("Also remove from Memory")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("button", { name: "Actions for Unread" })).toHaveCount(0);
  expect(memorySlugs(workspace)).toContain("unread-page");
});

test("a project offering many pages scrolls its list inside the dialog and keeps the buttons in reach", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const { project, papers: [paper], at } = await seed(workspace, ["Long list.pdf"], "Many");
  const concepts = Array.from({ length: 14 }, (_, index) => ({ slug: `idea-${String(index + 1).padStart(2, "0")}`, kind: "concept" as const, cites: [paper.id] }));
  fileFrom(workspace, paper.id, [{ slug: "many-page", kind: "source", cites: [] }, ...concepts]);
  await page.goto(`${workspace.origin}${at(paper)}`);

  const dialog = await removeProject(page, project.name);
  await expect(dialog.locator(".plan-capacity-row")).toHaveCount(15);
  const list = dialog.locator(".delete-modal-memory-list");
  const fit = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const scroller = element.querySelector(".delete-modal-memory-list")!;
    return { inside: box.top >= 0 && box.bottom <= window.innerHeight, scrolls: scroller.scrollHeight > scroller.clientHeight };
  });
  expect(fit).toEqual({ inside: true, scrolls: true });
  await expect(dialog.getByRole("button", { name: "Delete project and 15 pages" })).toBeInViewport();

  // The last row is reached inside the list, and the heading stays where it was.
  const heading = await dialog.getByRole("heading", { name: "Delete project?" }).boundingBox();
  const last = dialog.locator(".plan-capacity-row").last();
  const lastTitle = await last.locator("strong").textContent();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole("checkbox").uncheck();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await dialog.getByRole("heading", { name: "Delete project?" }).boundingBox()).toEqual(heading);
  await dialog.getByRole("button", { name: "Delete project and 14 pages" }).click();
  await expect(page.getByRole("button", { name: `Actions for ${project.name}` })).toHaveCount(0);
  await expect.poll(() => memorySlugs(workspace).filter((slug) => slug.startsWith("idea-") || slug === "many-page"))
    .toEqual([lastTitle!.toLowerCase().replace(" ", "-")]);
});

test("a project delete that fails takes no page with it, and a page that will not go says so", async ({ page }) => {
  test.setTimeout(90_000);
  const { project, papers: [paper], at } = await seed(workspace, ["Failing paper.pdf"], "Failing");
  // Somewhere for the reader to land, where its notices are shown.
  await seed(workspace, ["Landing paper.pdf"], "Landing");
  fileFrom(workspace, paper.id, [
    { slug: "failing-page", kind: "source", cites: [] },
    { slug: "stubborn-idea", kind: "concept", cites: [paper.id] },
  ]);
  const pageDeletes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && new URL(request.url()).pathname.includes("/pages/")) pageDeletes.push(request.url());
  });
  // The project's delete is held, then refused.
  let refuse!: () => void;
  const held = new Promise<void>((resolve) => { refuse = resolve; });
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await held;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "The project could not be deleted" }) });
  });
  await page.goto(`${workspace.origin}${at(paper)}`);

  let dialog = await removeProject(page, project.name);
  const remove = dialog.getByRole("button", { name: "Delete project and 2 pages" });
  await remove.click();
  // In flight, it cannot be pressed again.
  await expect(remove).toBeDisabled();
  refuse();
  await expect(page.getByText("The project could not be deleted")).toBeVisible();
  await expect(remove).toBeEnabled();
  expect(pageDeletes).toEqual([]);
  expect(memorySlugs(workspace)).toEqual(expect.arrayContaining(["failing-page", "stubborn-idea"]));

  // Then the project goes, and the one page refused stays and says so.
  await page.unroute(`**/api/projects/${project.id}`);
  await page.route((url) => url.pathname.endsWith("/pages/stubborn-idea"), (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
  await dialog.getByRole("button", { name: "Cancel" }).click();
  dialog = await removeProject(page, project.name);
  await dialog.getByRole("button", { name: "Delete project and 2 pages" }).click();
  await expect(page.getByText("Stubborn idea is still in Memory")).toBeVisible();
  await expect.poll(() => memorySlugs(workspace).filter((slug) => ["failing-page", "stubborn-idea"].includes(slug)))
    .toEqual(["stubborn-idea"]);
});
