import { expect, test, type Page } from "@playwright/test";
import { subscriptionWorkspace } from "../../../tests/fixtures/subscription-workspace.mts";

test.use({ actionTimeout: 10_000 });
let workspace: Awaited<ReturnType<typeof subscriptionWorkspace>>;
test.beforeEach(async ({ page, context }) => {
  workspace = await subscriptionWorkspace();
  const [name, value] = workspace.cookie.split("=");
  await context.addCookies([{ name, value, url: workspace.origin }]);
  workspace.onReload(() => { void page.reload().catch(() => {}); });
  await page.goto(workspace.origin + "/memory");
});
test.afterEach(async ({}, info) => {
  if (workspace && info.status !== info.expectedStatus) await info.attach("inference-diagnostics", { body: JSON.stringify(workspace.bridgeLogs, null, 2), contentType: "application/json" });
  await workspace?.close();
});
async function connections(page: Page) {
  await page.getByRole("button", { name: "Search and settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".settings-connection-row").getByRole("button", { name: "Change" }).click();
  await expect(page.getByRole("button", { name: /^Claude plan/ }).locator("img")).toHaveJSProperty("naturalWidth", 512);
}

test("switch a continuing Memory conversation from ChatGPT to Claude and back", async ({ page }) => {
  test.setTimeout(120_000);
  // Create through the public API, then continue through the shipped reader UI.
  const c = await (await workspace.request("/api/chat/conversations", { scope: "general", creation_key: "browser_switch" })).json();
  const first = await workspace.request("/api/chat/stream", { scope: "general", conversation_id: c.id, prompt: "Open attention and return its workflow receipt." });
  expect(await first.text()).toContain("WORKFLOW-RECEIPT-37");
  await page.goto(`${workspace.origin}/memory?ask=1&conversation=${c.id}`);
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitemradio", { name: /GPT-6.1 Sol/ }).click();
  await page.getByRole("menuitemradio", { name: "Max", exact: true }).click();
  for (const [id, name] of [["claude-subscription", "Claude"], ["chatgpt-oauth", "ChatGPT"]]) {
    await expect.poll(() => workspace.controller.busy()).toBeUndefined();
    await connections(page);
    await expect(page.getByRole("button", { name: /Claude API key/ })).toHaveCount(0);
    await page.getByRole("button", { name: new RegExp(`^${name} plan`) }).click();
    await page.getByRole("button", { name: `Use ${name}`, exact: true }).click();
    await expect.poll(() => workspace.profile().connectionId, { timeout: 30_000 }).toBe(id);
    await expect(page.getByRole("button", { name: "Close settings" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Model:/ })).toHaveAccessibleName(new RegExp(name === "Claude" ? "^Model: Opus 5.5.*Medium" : "GPT-6.1 Sol", "i"));
    if (name === "Claude") {
      for (const family of ["Haiku", "Sonnet", "Opus"]) {
        await page.getByRole("button", { name: /^Model:/ }).click();
        await page.getByRole("menuitemradio", { name: new RegExp(`^${family} 5.5`) }).click();
        await expect(page.locator('.model-picker-submenu [role="menuitemradio"]')).toHaveText(["Low", "Medium", "High", "xHigh"]);
        await page.getByRole("menuitemradio", { name: "xHigh", exact: true }).click();
        await expect(page.getByRole("button", { name: /^Model:/ })).toHaveAccessibleName(new RegExp(`^Model: ${family} 5.5.*xHigh`));
      }
      // Like GPT, unsent model choices live in the conversation session;
      // a full reload starts from this connection's defaults.
      await page.reload();
      await expect(page.getByRole("button", { name: /^Model:/ })).toHaveAccessibleName(/^Model: Opus 5.5.*Medium/);
      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.getByRole("menuitemradio", { name: /^Opus 5.5/ }).click();
      await page.getByRole("menuitemradio", { name: "xHigh", exact: true }).click();
    }
    await page.getByRole("textbox", { name: /^(Ask Delphi anything|Hint: press \/side)/ }).fill(`Open attention again using ${name}. Return its workflow receipt.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => {
      const history = await (await workspace.request(`/api/chat?scope=general&conversation_id=${c.id}`)).json();
      return history.messages.filter((m: any) => m.role === "assistant").length;
    }, { timeout: 30_000 }).toBe(name === "Claude" ? 2 : 3);
    await expect(page.getByText("WORKFLOW-RECEIPT-37", { exact: false }).last()).toBeVisible();
    const config = await (await workspace.request("/api/config")).json();
    expect(config.defaultModel).toBe(name === "Claude" ? "claude-opus-5-5" : "gpt-6.1-sol");
    if (name === "Claude") {
      expect(workspace.claude.calls().some(call => call.model === "claude-opus-5-5" && call.effort === "xhigh")).toBe(true);
    }
  }
  expect(workspace.managed).toEqual([]); // Existing CLI sign-in needs no setup or browser.
  expect(workspace.profile().username).toBe("workflow");
});

test("a signed-out CLI opens setup without changing the current connection", async ({ page }) => {
  workspace.claude.configure({ connected: false });
  await connections(page);
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  await expect(page.getByRole("button", { name: "Use Claude", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in to Claude…", exact: true }).click();
  await expect.poll(() => workspace.managed).toEqual(["claude-subscription"]);
  expect(workspace.profile().connectionId).toBe("chatgpt-oauth");
  await page.getByRole("button", { name: "Close settings" }).click();
  await connections(page);
  await page.getByRole("button", { name: /^ChatGPT plan/ }).click();
  await expect(page.locator(".settings-connection-status")).toContainText("In use");
});

test("Settings states the Claude Code requirement, shows the install command, and finds a later install", async ({ page }) => {
  await connections(page);
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  await expect(page.locator(".settings-pane-heading")).toContainText("Uses your Claude subscription through Claude Code (requires installation separately).");
  // Installed and signed in: nothing more to say about the requirement.
  await expect(page.locator(".settings-requirement")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await connections(page);
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  workspace.claude.uninstall();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: /^Claude plan/ })).toContainText("Not installed");
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  await expect(page.locator(".settings-connection-status")).toContainText("Claude Code not installed");
  await expect(page.locator(".settings-requirement")).toContainText("Claude Code installation is required:");
  await expect(page.locator(".settings-command code")).toHaveText("curl -fsSL https://claude.ai/install.sh | bash");
  await expect(page.getByRole("link", { name: "Installation guide" })).toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
  await expect(page.getByRole("button", { name: "Use Claude", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in to Claude…", exact: true })).toHaveCount(0);
  workspace.claude.install();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".settings-command")).toHaveCount(0);
  await page.getByRole("button", { name: "Use Claude", exact: true }).click();
  await expect.poll(() => workspace.profile().connectionId, { timeout: 30_000 }).toBe("claude-subscription");
  expect(workspace.managed).toEqual([]);
});

test("API keys list OpenAI and Claude, with the tier under OpenAI and Other endpoint coming", async ({ page }) => {
  await connections(page);
  await page.getByRole("button", { name: /^API keys/ }).click();
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
  const rows = page.locator(".settings-key-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("OpenAI");
  await expect(rows.nth(0)).toContainText("Key saved · Billed to your OpenAI account");
  await expect(rows.nth(0).getByRole("radiogroup", { name: "OpenAI service tier" })).toBeVisible();
  await expect(rows.nth(1)).toContainText("Claude");
  await expect(rows.nth(1).getByRole("radiogroup")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Coming soon" })).toContainText("Other endpoint");
  await rows.nth(0).getByRole("button", { name: "Replace key…", exact: true }).click();
  await expect.poll(() => workspace.managed).toEqual(["openai-api"]);
  await expect(rows.nth(0).getByRole("button", { name: "Use OpenAI", exact: true })).toBeEnabled();
  expect(workspace.profile().connectionId).toBe("chatgpt-oauth");
});

test("failed switch keeps the old service and shows a useful error", async ({ page }) => {
  workspace.failStart(true);
  await connections(page);
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  await page.getByRole("button", { name: "Use Claude", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("Delphi stayed on the previous connection", { timeout: 30_000 });
  expect(workspace.profile().connectionId).toBe("chatgpt-oauth");
  expect((await (await workspace.request("/api/config")).json()).defaultModel).toBe("gpt-6.1-sol");
});


test("an active answer refuses switching and cancellation allows retry without reopening settings", async ({ page }) => {
  const c = await (await workspace.request("/api/chat/conversations", { scope: "general", creation_key: "browser_busy" })).json();
  workspace.holdChat(true); const abort = new AbortController();
  const answer = await workspace.request("/api/chat/stream", { scope: "general", conversation_id: c.id, prompt: "Keep answering." }, { signal: abort.signal });
  const reader = answer.body!.getReader(); await reader.read();
  await connections(page);
  await page.getByRole("button", { name: /^Claude plan/ }).click();
  await page.getByRole("button", { name: "Use Claude", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("Delphi is busy");
  expect(workspace.profile().connectionId).toBe("chatgpt-oauth");
  abort.abort(); await reader.cancel().catch(() => {}); workspace.holdChat(false);
  await expect.poll(() => workspace.controller.busy()).toBeUndefined();
  await page.getByRole("button", { name: "Use Claude", exact: true }).click();
  await expect.poll(() => workspace.profile().connectionId, { timeout: 30_000 }).toBe("claude-subscription");
});
