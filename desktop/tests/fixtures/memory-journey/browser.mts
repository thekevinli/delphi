/**
 * The frontend's own Playwright, loaded as a library: no test runner, and only
 * the engine a run asks for.
 *
 * The part of its API the journey uses is typed here rather than imported, so
 * the shell's typecheck does not come to depend on the frontend's install.
 * Playwright's own types are assignable to these.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Text = string | RegExp;
type Within = { hasText?: Text };

export interface Locator {
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  filter(options: Within): Locator;
  locator(selector: string, options?: Within): Locator;
  getByRole(role: "button" | "dialog" | "heading" | "img" | "navigation" | "region" | "status" | "tab" | "tablist" | "textbox", options?: { name?: Text; exact?: boolean }): Locator;
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  toString(): string;
}

export interface Response {
  status(): number;
  finished(): Promise<null | Error>;
}

export interface Request {
  url(): string;
  method(): string;
  postData(): string | null;
  postDataJSON(): unknown;
  response(): Promise<Response | null>;
}

export interface Page {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  url(): string;
  on(event: "pageerror", listener: (error: Error) => void): unknown;
  on(event: "request", listener: (request: Request) => void): unknown;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  locator(selector: string, options?: Within): Locator;
  getByRole: Locator["getByRole"];
  waitForRequest(predicate: (request: Request) => boolean, options?: { timeout?: number }): Promise<Request>;
  keyboard: { press(key: string): Promise<void> };
}

export interface BrowserContext {
  setDefaultTimeout(timeout: number): void;
  addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
  newPage(): Promise<Page>;
}

export interface Browser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
  close(): Promise<void>;
}

export interface BrowserType {
  launch(): Promise<Browser>;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** `chromium` or `webkit`, from the Playwright the frontend's browser suite installs. */
export function engine(name: string): BrowserType {
  if (name !== "chromium" && name !== "webkit") throw new Error(`DELPHI_JOURNEY_BROWSER is chromium or webkit, not "${name}"`);
  let library: Record<"chromium" | "webkit", BrowserType>;
  try {
    const frontend = createRequire(join(root, "frontend", "package.json"));
    library = createRequire(frontend.resolve("@playwright/test"))("playwright");
  } catch (error) {
    throw new Error(`The frontend's Playwright is not installed: run \`npm run build\` (${String(error)})`);
  }
  return library[name];
}
