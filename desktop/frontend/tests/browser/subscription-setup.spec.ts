import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { fixtureClaude } from "../../../tests/fixtures/claude-runtime.mts";
import { parseSetup } from "../../../main/browser-policy.ts";

// The real setup document and script, with only Electron's two IPC methods
// supplied by the test. Claude sign-in still crosses a native process boundary.
let claude: ReturnType<typeof fixtureClaude>;
let selected = "claude-subscription", managing = false, busy = "";
let keys = { openai: false, claude: false };
let chatgpt: Record<string, unknown>;
let saved: unknown[], commands: string[];
/** A status read that fails, or one held back until released. */
let failedReads = 0, heldRead: Promise<void> | undefined, holding = false;
test.beforeEach(async ({ page }) => {
  claude = fixtureClaude({ connected: false, loginDelay: 200 });
  selected = "claude-subscription"; managing = false; keys = { openai: false, claude: false }; busy = "";
  chatgpt = { connected: true, signingIn: false, usage: { plan: "Plus" } };
  saved = []; commands = []; failedReads = 0; heldRead = undefined; holding = false;
  await page.exposeFunction("setupConnection", async ({ action, to }: { action: string; to: string }) => {
    commands.push(action + ":" + to);
    if (busy && ["save", "use-saved-key"].includes(action)) return { ok: false, message: busy };
    if (action === "login") await claude.connection.login();
    if (action === "cancel") await claude.connection.cancel();
    if (action === "logout") await claude.connection.logout();
    if (action === "save") { if (to === "claude-subscription") await claude.connection.ready(); saved.push(to); }
    if (action === "use-saved-key") saved.push("saved-key");
    if (action === "status" && failedReads) { failedReads--; return { ok: false, message: "Couldn’t read the connection." }; }
    const reply = { ok: true, selected, managing, keys, chatgpt, claude: await claude.connection.status() };
    if (action === "status" && heldRead) { const held = heldRead; heldRead = undefined; holding = true; await held; }
    return reply;
  });
  await page.exposeFunction("setupKey", async (value: unknown) => {
    try {
      const setup = parseSetup(value);
      if (setup.apiKey === "sk-refused") return { ok: false, message: "That key was refused." };
      saved.push(setup); return { ok: true };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  });
  await page.addInitScript(() => { (window as any).delphi = { connection: (window as any).setupConnection, saveSetup: (window as any).setupKey }; });
  await page.route("http://setup.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path === "/setup.js") {
      await route.fulfill({ contentType: path === "/" ? "text/html" : "text/javascript", body: readFileSync(new URL(`../../../onboarding/${path === "/" ? "index.html" : "setup.js"}`, import.meta.url), "utf8") });
    } else if (/^\/frontend\/public\/brand\/(chatgpt|claude)\.png$/.test(path)) {
      await route.fulfill({ contentType: "image/png", body: readFileSync(new URL(`../../public/brand/${path.split("/").at(-1)}`, import.meta.url)) });
    } else await route.fulfill({ status: 404, body: "" });
  });
  await page.setViewportSize({ width: 560, height: 860 });
});
test.afterEach(async () => { await claude.connection.cancel(); claude.remove(); });

const card = (page: Page, name: RegExp) => page.getByRole("button", { name });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Everything the window shows, so a state that grows a second message is caught. */
async function words(page: Page) {
  const shown = await page.locator("main > :not(.visually-hidden)").evaluateAll(parts =>
    parts.filter(part => part.checkVisibility()).map(part => (part as HTMLElement).innerText));
  return shown.join(" ").replace(/\s+/g, " ").trim();
}

test("first run signs in with Claude, then the card names the plan and one button continues", async ({ page }) => {
  await page.goto("http://setup.test/");
  await expect(page.locator("#choose-claude img")).toHaveJSProperty("naturalWidth", 512);
  await expect(page.getByRole("heading", { name: "Welcome to Delphi" })).toBeVisible();
  await expect(card(page, /^Claude subscription Pro or above/)).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, /^ChatGPT subscription Plus plan/)).toBeVisible();
  await button(page, "Continue with Claude").click();
  await expect(button(page, "Finish in your browser…")).toBeDisabled();
  await expect(button(page, "Cancel")).toBeVisible();
  expect(await words(page)).toBe("Welcome to Delphi Connect a model to start reading. ChatGPT subscription Plus plan Claude subscription Pro or above API key OpenAI or Claude, pay per use Finish in your browser… Cancel Delphi data stays only on your Mac.");
  await expect(card(page, /^Claude subscription Max plan/)).toBeVisible();
  await expect(button(page, "Sign out")).toBeVisible();
  expect(await words(page)).toBe("Welcome to Delphi Connect a model to start reading. ChatGPT subscription Plus plan Claude subscription Max plan API key OpenAI or Claude, pay per use Continue Sign out Delphi data stays only on your Mac.");
  await button(page, "Continue").click();
  await expect.poll(() => saved).toEqual(["claude-subscription"]);
  await expect(button(page, "Starting Delphi…")).toBeDisabled();
  await expect(button(page, "Sign out")).toBeHidden();
  await expect(card(page, /^ChatGPT subscription/)).toBeDisabled();
});

test("from Settings: update Claude Code, cancel a sign-in, then switch to ChatGPT", async ({ page }) => {
  managing = true;
  claude.configure({ connected: false, version: "2.1.0 (Claude Code)", loginDelay: 60_000 });
  await page.goto("http://setup.test/");
  await expect(page.getByRole("heading", { name: "AI connection" })).toBeVisible();
  await expect(page.locator("#lede")).toBeHidden();
  await expect(page.locator("#claude-install-lead")).toHaveText("Claude Code needs an update:");
  await expect(page.locator("#claude-install-command")).toHaveText("claude update");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(button(page, "Continue with Claude")).toBeHidden();
  await button(page, "Installation guide").click();
  await expect(button(page, "Installation guide")).toBeEnabled();
  expect(commands).toContain("install:claude-subscription");
  // Updated in Terminal; coming back to the window is the check.
  claude.configure({ connected: false, loginDelay: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await button(page, "Continue with Claude").click();
  await button(page, "Cancel").click();
  await expect(button(page, "Continue with Claude")).toBeEnabled();
  expect(saved).toEqual([]);
  await card(page, /^ChatGPT subscription/).click();
  await expect(button(page, "Sign out")).toBeVisible();
  await button(page, "Switch").click();
  await expect.poll(() => saved).toEqual(["chatgpt-oauth"]);
  await expect(button(page, "Switching…")).toBeDisabled();
});

test("a switch refused while Delphi works says why in one line and can be retried", async ({ page }) => {
  managing = true; selected = "chatgpt-oauth"; busy = "Delphi is busy. Switch when it’s done.";
  await page.goto("http://setup.test/");
  await button(page, "Switch").click();
  await expect(page.getByRole("alert")).toHaveText("Delphi is busy. Switch when it’s done.");
  await expect(button(page, "Switch")).toBeEnabled();
  busy = "";
  await button(page, "Switch").click();
  await expect.poll(() => saved).toEqual(["chatgpt-oauth"]);
});

test("a reached usage limit shows on the plan line", async ({ page }) => {
  selected = "chatgpt-oauth";
  chatgpt = { connected: true, signingIn: false, usage: { plan: "Plus", blockedUntil: "Oct 24, 3 PM" } };
  await page.goto("http://setup.test/");
  await expect(page.locator("#chatgpt-detail")).toHaveText("Plus plan · limit reached until Oct 24, 3 PM");
  await expect(page.locator("#chatgpt-detail")).toHaveClass(/is-limited/);
});

test("a Claude Code sign-in made with API billing is reported once, above the sign-in button", async ({ page }) => {
  claude.configure({ connected: true, authMethod: "api_key" });
  await page.goto("http://setup.test/");
  await expect(page.getByRole("alert")).toHaveText("Sign in with a Claude subscription, not an API account.");
  await expect(button(page, "Continue with Claude")).toBeVisible();
  await expect(card(page, /^Claude subscription Pro or above/)).toBeVisible();
});

test("first Delphi connection reuses Claude Code without browser sign-in or logout", async ({ page }) => {
  claude.configure({ connected: true });
  await page.goto("http://setup.test/");
  await expect(button(page, "Continue with Claude")).toBeHidden();
  await button(page, "Continue").click();
  await expect.poll(() => saved).toEqual(["claude-subscription"]);
  expect(commands).not.toContain("login:claude-subscription");
  expect(commands).not.toContain("logout:claude-subscription");
});

test("without Claude Code, setup shows the install command and picks up an install made meanwhile", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  claude.configure({ connected: true }); // Signed in before; only the binary is missing.
  claude.uninstall();
  await page.goto("http://setup.test/");
  await expect(page.locator("#claude-install-lead")).toHaveText("Claude Code installation is required:");
  await expect(page.locator("#claude-install-command")).toHaveText("curl -fsSL https://claude.ai/install.sh | bash");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(button(page, "Continue with Claude")).toBeHidden();
  await expect(button(page, "Continue")).toBeHidden();
  expect(await words(page)).toBe("Welcome to Delphi Connect a model to start reading. ChatGPT subscription Plus plan Claude subscription Pro or above API key OpenAI or Claude, pay per use Claude Code installation is required: curl -fsSL https://claude.ai/install.sh | bash Copy Installation guide Delphi data stays only on your Mac.");
  await button(page, "Copy").click();
  await expect(page.getByRole("button", { name: /^(Copied|Press ⌘C)$/ })).toBeVisible();
  claude.install();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#claude-install")).toBeHidden();
  await button(page, "Continue").click();
  await expect.poll(() => saved).toEqual(["claude-subscription"]);
});

test("Claude Code removed after sign-in is noticed when the window regains focus", async ({ page }) => {
  claude.configure({ connected: true });
  await page.goto("http://setup.test/");
  await expect(button(page, "Continue")).toBeVisible();
  claude.uninstall();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#claude-install-command")).toHaveText("curl -fsSL https://claude.ai/install.sh | bash");
  await expect(button(page, "Continue")).toBeHidden();
  claude.install();
  await card(page, /^ChatGPT subscription/).click();
  await card(page, /^Claude subscription/).click();
  await expect(button(page, "Continue")).toBeVisible();
});

test("an API key: the provider decides the placeholder, and a key under the wrong provider is refused", async ({ page }) => {
  await page.goto("http://setup.test/");
  await card(page, /^API key/).click();
  const provider = page.getByRole("combobox", { name: "Provider" });
  const key = page.getByRole("textbox", { name: "API key" });
  await expect(provider).toHaveValue("openai");
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("placeholder", "Paste your OpenAI key (sk-…)");
  // Other providers will come through an OpenAI-compatible base URL; until then it is listed, not offered.
  await expect(provider.locator("option", { hasText: "Claude" })).toBeEnabled();
  await expect(provider.locator("option", { hasText: "Other endpoint" })).toBeDisabled();
  await expect(provider.locator("optgroup")).toHaveAttribute("label", "Coming soon");
  await expect(page.getByRole("textbox", { name: "OpenAI-compatible base URL" })).toHaveCount(0);
  await button(page, "Continue").click();
  await expect(page.getByRole("alert")).toHaveText("Paste a key first.");
  await key.fill("sk-refused");
  await button(page, "Continue").click();
  await expect(page.getByRole("alert")).toHaveText("That key was refused.");
  await expect(button(page, "Continue")).toBeEnabled();
  // A Claude key pasted as OpenAI is refused before anything is saved.
  await key.fill("sk-ant-test-key-never-saved");
  await button(page, "Continue").click();
  await expect(page.getByRole("alert")).toHaveText("That is a Claude API key. Choose Claude in the provider menu.");
  expect(saved).toEqual([]);
  await provider.selectOption("claude");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("placeholder", "Paste your Claude API key (sk-ant-…)");
  await button(page, "Continue").click();
  await expect.poll(() => saved).toEqual([{ provider: "claude", apiKey: "sk-ant-test-key-never-saved" }]);
  await expect(button(page, "Starting Delphi…")).toBeDisabled();
  await expect(provider).toBeDisabled();
});

test("an OpenAI key is saved as OpenAI's, and a non-Claude key is refused under Claude", async ({ page }) => {
  await page.goto("http://setup.test/");
  await card(page, /^API key/).click();
  const provider = page.getByRole("combobox", { name: "Provider" });
  await provider.selectOption("claude");
  await page.getByRole("textbox", { name: "API key" }).fill("sk-openai");
  await page.getByRole("textbox", { name: "API key" }).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("A Claude API key starts with sk-ant-.");
  await provider.selectOption("openai");
  await page.getByRole("textbox", { name: "API key" }).press("Enter");
  await expect.poll(() => saved).toEqual([{ provider: "openai", apiKey: "sk-openai" }]);
});

test("from Settings, a saved key switches in one press, or is replaced", async ({ page }) => {
  managing = true; keys = { openai: true, claude: false }; selected = "openai-api";
  await page.goto("http://setup.test/");
  await expect(card(page, /^API key Saved on this Mac/)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "API key" })).toBeHidden();
  await button(page, "Use a new key").click();
  await expect(page.getByRole("textbox", { name: "API key" })).toBeFocused();
  await expect(card(page, /^API key OpenAI or Claude, pay per use/)).toBeVisible();
  await expect(button(page, "Use a new key")).toBeHidden();
  await page.getByRole("textbox", { name: "API key" }).fill("sk-new");
  await button(page, "Switch").click();
  await expect.poll(() => saved).toEqual([{ provider: "openai", apiKey: "sk-new" }]);
  await expect(button(page, "Switching…")).toBeDisabled();
  saved = [];
  await page.reload();
  await button(page, "Switch").click();
  await expect.poll(() => saved).toEqual(["saved-key"]);
  await expect(button(page, "Switching…")).toBeDisabled();
});

test("from Settings, a saved Claude key opens on Claude and switches in one press", async ({ page }) => {
  managing = true; keys = { openai: false, claude: true }; selected = "claude-api";
  await page.goto("http://setup.test/");
  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toHaveValue("claude");
  await expect(card(page, /^API key Saved on this Mac/)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "API key" })).toBeHidden();
  // Each provider's key is its own: OpenAI has none, so its field is asked for.
  await provider.selectOption("openai");
  await expect(page.getByRole("textbox", { name: "API key" })).toBeVisible();
  await provider.selectOption("claude");
  await button(page, "Switch").click();
  await expect.poll(() => commands).toContain("use-saved-key:claude-api");
  await expect(button(page, "Switching…")).toBeDisabled();
});

test("signing out from Settings leaves the card asking for a sign-in again", async ({ page }) => {
  managing = true; claude.configure({ connected: true });
  await page.goto("http://setup.test/");
  await expect(card(page, /^Claude subscription Max plan/)).toBeVisible();
  await button(page, "Sign out").click();
  await expect(button(page, "Continue with Claude")).toBeEnabled();
  await expect(card(page, /^Claude subscription Pro or above/)).toBeVisible();
  await expect(button(page, "Sign out")).toBeHidden();
  expect(commands).toContain("logout:claude-subscription");
  expect(saved).toEqual([]);
});

test("a signed-in account's notice is not shown as a failure", async ({ page }) => {
  selected = "chatgpt-oauth";
  chatgpt = { connected: true, signingIn: false, usage: { plan: "Plus" }, message: "Can’t reach ChatGPT. Check your internet." };
  await page.goto("http://setup.test/");
  await expect(button(page, "Continue")).toBeVisible();
  await expect(page.locator("#error")).toBeEmpty();
  chatgpt = { connected: false, signingIn: false, message: "Can’t reach ChatGPT. Check your internet." };
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("Can’t reach ChatGPT. Check your internet.");
});

test("a status that could not be read is said once, and goes away when a read succeeds", async ({ page }) => {
  failedReads = 1;
  await page.goto("http://setup.test/");
  await expect(page.getByRole("alert")).toHaveText("Couldn’t read the connection.");
  await card(page, /^Claude subscription/).click();
  await expect(page.locator("#error")).toBeEmpty();
  await expect(button(page, "Continue with Claude")).toBeEnabled();
});

test("a status reply overtaken by a later one does not undo it", async ({ page }) => {
  let release!: () => void;
  heldRead = new Promise(resolve => { release = resolve; });
  await page.goto("http://setup.test/");
  await expect.poll(() => holding).toBe(true);
  // Signed in meanwhile, in Terminal; choosing the card reads again.
  claude.configure({ connected: true });
  await card(page, /^Claude subscription/).click();
  await expect(card(page, /^Claude subscription Max plan/)).toBeVisible();
  release();
  await expect.poll(() => commands.filter(command => command.startsWith("status:")).length).toBe(2);
  await page.waitForTimeout(200);
  expect(await page.locator("#claude-detail").textContent()).toBe("Max plan");
  expect(await button(page, "Continue").isVisible()).toBe(true);
});
