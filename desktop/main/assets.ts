/**
 * The Worker's `ASSETS` binding, backed by the built `dist/client` directory.
 *
 * On Cloudflare this binding is not code we write: `wrangler.json`'s
 * `assets.directory` is served by the platform. Reproducing it here is what
 * lets the Electron main process run Delphi's real build output unmodified.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

/** Content types for everything `frontend/public` and the build actually emit. */
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export function createAssets(distDir: string): AssetsBinding {
  const root = join(distDir, "client");
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      // normalize() collapses `..` before it can climb out of dist/client.
      const relative = normalize(decodeURIComponent(pathname)).replace(
        /^(\.\.[/\\])+/,
        "",
      );
      const file = join(root, relative);
      if (!file.startsWith(root)) return new Response("Not found", { status: 404 });

      let size: number;
      try {
        const info = await stat(file);
        if (!info.isFile()) return new Response("Not found", { status: 404 });
        size = info.size;
      } catch {
        return new Response("Not found", { status: 404 });
      }

      return new Response(await readFile(file), {
        status: 200,
        headers: {
          /*
           * `withCssCharset` in `frontend/worker/index.ts` only
           * reaches responses the Worker itself builds, never the ones this
           * binding returns — and the bug it exists for was a stylesheet
           * decoded as Latin-1 on roughly one load in five. So the charset is
           * named here too.
           */
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": String(size),
          /*
           * Explicit, because no cache header does not mean "no cache" — it
           * means Chrome's heuristic cache, which makes a *wrong* response
           * sticky. While assets were briefly answered by the SSR route, the
           * renderer cached `/assets/index-*.js` as text/html and kept failing
           * the module import for minutes after the server was correct.
           * `/assets/*` filenames carry a content hash and so are genuinely
           * immutable; nothing else is.
           */
          "cache-control": relative.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    },
  };
}
