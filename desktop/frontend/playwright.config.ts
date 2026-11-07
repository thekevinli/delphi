import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://127.0.0.1:3218", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm exec vite --config tests/browser/vite.config.mts",
    url: "http://127.0.0.1:3218/tests/browser/harness.html",
    reuseExistingServer: false,
  },
});
