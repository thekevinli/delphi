import { test, expect, type Page } from "@playwright/test";
import type { Persona } from "../../app/lib/api";
import { officialPersonas } from "./persona-fixture";

async function setup(page: Page, marketplace = false) {
  const mine: Persona[] = [];
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  let fail = false;
  await page.route("**/desktop/**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/personas")) return route.fulfill({ json: [] });
    if (request.method() !== "GET") {
      const body = request.method() === "DELETE" ? {} : request.postDataJSON();
      writes.push({ method: request.method(), body });
      if (fail) return route.fulfill({ status: 409, json: { detail: "This persona changed. Try again." } });
      if (request.method() === "DELETE") { mine.splice(0); return route.fulfill({ json: {} }); }
      const persona = { ...body, id: "custom", official: false, revision: 2 } as Persona;
      mine.splice(0, mine.length, persona);
      return route.fulfill({ json: persona });
    }
    return route.fulfill({ json: path === "/api/personas" ? { official: officialPersonas, mine } : [...officialPersonas, ...mine].find(item => path.endsWith(`/${item.id}`)) });
  });
  await page.goto(`/tests/browser/harness.html?persona${marketplace ? "&marketplace" : ""}`);
  await expect(page.getByRole("button", { name: "See Mentor in detail" })).toBeVisible();
  return { writes, fail: (value: boolean) => { fail = value; } };
}

test("persona list opens officials and macOS creates, edits and deletes private personas", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByText("No personas yet", { exact: true })).toBeVisible();
  await expect(page.getByText(/marketplace/i)).toHaveCount(0);
  await page.getByRole("button", { name: "See Mentor in detail" }).click();
  await expect(page.getByRole("complementary", { name: "Mentor instructions" })).toContainText(officialPersonas[0].content);
  await page.getByRole("button", { name: "New persona", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create persona" })).toBeDisabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Skeptical reviewer");
  await page.getByLabel("One-line description").fill("Check the evidence first.");
  await page.getByLabel(/^Instructions/).fill("Cite sources and explain uncertainty.");
  await page.getByRole("radio", { name: "stone", exact: true }).press("ArrowRight");
  await expect(page.getByRole("radio", { name: "wind", exact: true })).toBeChecked();
  await expect(page.locator(".persona-count")).toHaveText("37 / 30,000");
  await page.getByRole("button", { name: "Create persona" }).click();
  await expect(page.getByRole("button", { name: "See Skeptical reviewer in detail" })).toBeVisible();
  expect(state.writes[0].body).toMatchObject({ name: "Skeptical reviewer", element: "wind", visibility: "private", capabilities: [] });
  await expect(page.getByTestId("persona-changes")).toHaveText("1");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel(/^Instructions/)).toHaveValue("Cite sources and explain uncertainty.");
  state.fail(true);
  await page.getByLabel("Name", { exact: true }).fill("Careful reviewer");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("persona-notice")).toContainText("This persona changed");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Careful reviewer");
  expect(state.writes[1].body.expected_revision).toBe(2);
  state.fail(false);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No personas yet", { exact: true })).toBeVisible();
});

test("marketplace controls follow the capability and publishing remains opt-in", async ({ page }) => {
  const state = await setup(page, true);
  await expect(page.getByRole("button", { name: "marketplace", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New persona", exact: true }).click();
  const publish = page.getByRole("checkbox", { name: /Publish to marketplace/ });
  await expect(publish).not.toBeChecked();
  await page.getByLabel("Name", { exact: true }).fill("Published example");
  await page.getByLabel(/^Instructions/).fill("An example instruction.");
  await publish.check();
  await page.getByRole("button", { name: "Create persona" }).click();
  expect(state.writes[0].body.visibility).toBe("public");
});

test("the editor footer stays visible and cancel and back discard an unsaved draft", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 620 });
  const state = await setup(page);
  await page.getByRole("button", { name: "New persona", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved");
  const footer = await page.locator(".persona-editor-footer").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(620);
  expect(await page.locator(".persona-editor-pane").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New persona", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Back to Persona", exact: true }).click();
  await expect(page.getByText("No personas yet", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("Persona and its editor keep the shared Settings modal dimensions", async ({ page }) => {
  await setup(page);
  const modal = page.locator(".settings-modal");
  const dimensions = () => modal.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const sharedDimensions = await dimensions();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  await expect.poll(dimensions).toEqual(sharedDimensions);
  await page.getByRole("button", { name: "New persona", exact: true }).click();
  await expect.poll(dimensions).toEqual(sharedDimensions);
});
