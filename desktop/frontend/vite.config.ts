import vinext from "vinext";
import { defineConfig } from "vite";
// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  // Origin of the FastAPI backend. The Worker forwards /api/* there so the
  // browser only ever talks to one origin, which keeps the session cookie
  // first-party and avoids CORS entirely. Empty locally, where the backend is
  // reached directly on :8000.
  vars: { BACKEND_URL: process.env.BACKEND_URL ?? "" },

};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // `::search-text` (invariant: the find-in-page band in `globals.css`) is
    // newer than lightningcss 1.33, which Vite 8 defaults to for CSS
    // minification. It parses the unknown pseudo-element with a warning and
    // then hard-fails on `::search-text:current`, because it only allows
    // user-action pseudo-classes after a pseudo-element it does not know.
    // esbuild's minifier passes unknown selectors through untouched, which is
    // the behaviour we want for a progressively-enhanced pseudo: browsers that
    // have it paint the band, browsers that do not ignore the rule.
    build: { cssMinify: "esbuild" as const },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
