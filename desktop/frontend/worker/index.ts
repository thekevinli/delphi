/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";


interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Origin of the FastAPI backend: in the desktop app, its loopback address. */
  BACKEND_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Reserve former web portals so the reader's dynamic route cannot absorb them.
    // Local session provisioning still uses register/login in the main process.
    if (["/landing", "/login", "/register", "/api/auth/logout", "/api/auth/change-password"].includes(url.pathname.replace(/\/$/, ""))) {
      await request.body?.pipeTo(new WritableStream({ write() {} }));
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    // Memory's address before 0.7.0, kept for bookmarks: the same page at /memory, query and all.
    // Here rather than next.config's redirects(), which vinext answers without the query.
    // `.rsc` is the root page's client-navigation request; a subpath's is under its own path.
    const formerMemory = url.pathname.match(/^\/knowledge-base(\.rsc|\/.*)?$/);
    if (formerMemory) {
      await request.body?.pipeTo(new WritableStream({ write() {} }));
      return new Response(null, { status: 307, headers: { Location: `/memory${formerMemory[1] ?? ""}${url.search}`, "Cache-Control": "no-store" } });
    }
    // Forward the API to Cloud Run from this same origin. Doing it here rather
    // than pointing the browser straight at the backend is what keeps the
    // session cookie first-party: SameSite=Lax survives, no CORS is involved,
    // and there is one URL to share.
    if (env.BACKEND_URL && url.pathname.startsWith("/api/")) {
      const target = new URL(url.pathname + url.search, env.BACKEND_URL);
      // Request is passed through whole so the body streams rather than
      // buffering — an upload can be 60 MB before compression and chat
      // responses are SSE that can run for fifteen minutes.
      const proxied = new Request(target, request);
      proxied.headers.set("X-Forwarded-Host", url.host);
      proxied.headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      return fetch(proxied);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return withCssCharset(await handler.fetch(request, env, ctx));
  },
};

/**
 * Name the encoding on every stylesheet this Worker actually serves.
 *
 * `public/_headers` already asks Cloudflare's asset server to send
 * `charset=utf-8` on `/assets/*.css`, but that file is not the path a first
 * load always takes: vinext reconstructs the Response, the dev server sends
 * a bare `text/css`, and a speculative CSS fetch can decode the file before
 * the HTML document's encoding is known. The fallback was Latin-1, so a
 * UTF-8 triangle in `content:` arrived as "â–¸" on roughly one load in five
 * and looked right after a refresh. Drawn marks no longer depend on this;
 * the header is what keeps any remaining non-ASCII from hitting the same
 * guess.
 */
function withCssCharset(response: Response): Response {
  const type = response.headers.get("Content-Type") ?? "";
  if (!/^text\/css\b/i.test(type) || /charset=/i.test(type)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/css; charset=utf-8");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default worker;
