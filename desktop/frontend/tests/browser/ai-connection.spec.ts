import { test, expect, type Page } from "@playwright/test";

type State = { connection: string; keys: { openai: boolean; claude: boolean } };
const plans = { chatgpt: { connected: true }, claude: { connected: true, usage: { plan: "Max", percentLeft: 65, weekly: true, resets: "Oct 31" } } };

/** Settings over a stubbed shell. `requests` is what the sheet asked the shell
 *  for; `tier` is every preference write. */
async function setup(page: Page, state: State, query = "") {
  const requests: unknown[] = [], tier: unknown[] = [];
  await page.route("**/desktop/connection", async route => {
    if (route.request().method() === "POST") { requests.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { ...state, ...plans } });
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/auth/preferences") {
      const body = request.postDataJSON() as { use_standard_tier: boolean };
      tier.push(body);
      return route.fulfill({ json: { useStandardTier: body.use_standard_tier } });
    }
    return route.fulfill({ json: [] });
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`/tests/browser/harness.html?ai-connection${query}`);
  return { requests, tier };
}
const row = (page: Page, name: string) => page.locator(".settings-key-row").filter({ has: page.getByText(name, { exact: true }) });

test("on a plan, Advanced shows the connection alone, with no tier", async ({ page }) => {
  await setup(page, { connection: "claude-subscription", keys: { openai: true, claude: false } });
  const model = page.getByRole("region", { name: "Model" });
  await expect(model).toContainText("Claude plan");
  await expect(model).toContainText("65% of weekly usage left, resets Oct 31");
  await expect(model.getByRole("radiogroup")).toHaveCount(0);
  await expect(page.getByText("Service tier")).toHaveCount(0);
});

test("on an OpenAI key, Advanced states its tier; on a Claude key, only who bills", async ({ page }) => {
  await setup(page, { connection: "openai-api", keys: { openai: true, claude: false } }, "&flex");
  const model = page.getByRole("region", { name: "Model" });
  await expect(model).toContainText("OpenAI API key");
  await expect(model).toContainText("Billed to your OpenAI account · Flex tier");
  await expect(model.getByRole("radiogroup")).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" });
  await setup(page, { connection: "claude-api", keys: { openai: false, claude: true } });
  await expect(model).toContainText("Claude API key");
  await expect(model).toContainText("Billed to your Anthropic account");
  await expect(model).not.toContainText("tier");
});

test("API keys: OpenAI's row carries the tier, Claude's never does, and Other endpoint is coming", async ({ page }) => {
  const { requests, tier } = await setup(page, { connection: "openai-api", keys: { openai: true, claude: true } }, "&connection");
  await page.getByRole("button", { name: /^API keys/ }).click();
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
  await expect(page.locator(".settings-key-row")).toHaveCount(2);

  const openai = row(page, "OpenAI"), claude = row(page, "Claude");
  await expect(openai).toContainText("Key saved · Billed to your OpenAI account");
  await expect(openai).toContainText("In use");
  await expect(openai).toContainText("Flex costs less but response may be slower");
  const tierControl = openai.getByRole("radiogroup", { name: "OpenAI service tier" });
  await expect(tierControl.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  await expect(claude).toContainText("Key saved · Billed to your Anthropic account");
  await expect(claude.getByRole("radiogroup")).toHaveCount(0);

  // The tier is the same account preference it always was.
  await tierControl.getByRole("radio", { name: "Flex" }).click();
  await expect.poll(() => tier).toEqual([{ use_standard_tier: false }]);
  await expect(page.getByTestId("tier")).toHaveText("flex");

  // The check switches to that key; replacing one opens the AI Connection window.
  await claude.getByRole("button", { name: "Use Claude", exact: true }).click();
  await openai.getByRole("button", { name: "Replace key…" }).click();
  await expect.poll(() => requests).toEqual([{ action: "switch", to: "claude-api" }, { action: "manage", to: "openai-api" }]);

  // Only a base URL is promised, and nothing in it can be chosen.
  const coming = page.getByRole("region", { name: "Coming soon" });
  await expect(coming).toContainText("Other endpoint");
  await expect(coming).toContainText("Any OpenAI-compatible base URL");
  await expect(coming).not.toContainText(/OpenRouter|Fireworks/);
  await expect(coming.getByRole("button")).toHaveCount(0);
  // No Done: the row's own button chooses, and the sheet already has its ways out.
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
});

test("with no OpenAI key there is no tier to set, and each key asks to be added", async ({ page }) => {
  const { requests } = await setup(page, { connection: "claude-subscription", keys: { openai: false, claude: false } }, "&connection");
  await page.getByRole("button", { name: /^API keys/ }).click();
  await expect(row(page, "OpenAI")).toContainText("No key saved");
  await expect(page.getByRole("radiogroup", { name: "OpenAI service tier" })).toHaveCount(0);
  await expect(row(page, "OpenAI").getByRole("button", { name: /^Use/ })).toHaveCount(0);
  await row(page, "Claude").getByRole("button", { name: "Add a key…" }).click();
  await expect.poll(() => requests).toEqual([{ action: "manage", to: "claude-api" }]);
});
