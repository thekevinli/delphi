import { findDocumentText } from "../frontend/app/lib/document-find.ts";

export function readerFindHandler(options: {
  origin: string;
  authenticate: (request: Request) => Promise<boolean>;
  run: (frameName: string, script: string) => Promise<unknown>;
  /** `executeJavaScript` never settles in a frame that navigated or was replaced. */
  timeoutMs?: number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== "/desktop/reader/find") return;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("origin") !== options.origin || !await options.authenticate(request)) return new Response(null, { status: 403 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.query !== "string" || body.query.length > 500 || !Number.isSafeInteger(body.index) || typeof body.frameName !== "string" || !/^delphi-frame-[\w-]{1,64}$/.test(body.frameName)) return new Response(null, { status: 400 });
    try {
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([options.run(body.frameName, `(${findDocumentText.toString()})(${JSON.stringify(body.query)},${body.index})`),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Reader frame did not answer")), options.timeoutMs ?? 5_000); }),
      ]).finally(() => clearTimeout(timer));
      return Response.json(result);
    } catch {
      return Response.json({ error: "The page is not ready to search." }, { status: 409 });
    }
  };
}
