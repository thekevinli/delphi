/** Restore desktop receipts a message at a time. A conversation has no turn
 * limit, so a whole-history buffer cannot be both bounded and reload-safe.
 * Eight MiB per message accommodates two 128k-character artifacts even with
 * six-byte JSON escapes, leaving over six MiB for prose and trace metadata.
 * Other top-level metadata keeps the existing one-MiB bound. */
export const HISTORY_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
const METADATA_MAX_BYTES = 1024 * 1024;

class JsonInput {
  private text = "";
  private position = 0;
  private ended = false;
  private decoder = new TextDecoder();
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) { this.reader = reader; }

  private async ready(): Promise<boolean> {
    while (this.position === this.text.length && !this.ended) {
      const { value, done } = await this.reader.read();
      this.ended = done;
      this.text = done ? this.decoder.decode() : this.decoder.decode(value, { stream: true });
      this.position = 0;
    }
    return this.position < this.text.length;
  }

  async peek(): Promise<string | undefined> {
    while (await this.ready()) {
      while (this.position < this.text.length && /\s/.test(this.text[this.position])) this.position++;
      if (this.position < this.text.length) return this.text[this.position];
    }
  }

  async expect(character: string): Promise<void> {
    if (await this.peek() !== character) throw new Error("Incomplete or invalid chat history JSON");
    this.position++;
  }

  async value(limit: number): Promise<string> {
    const first = await this.peek();
    if (first === undefined) throw new Error("Incomplete chat history JSON");
    const parts: string[] = [];
    let bytes = 0, depth = 0, quoted = false, escaped = false;
    const primitive = !'[{"'.includes(first);
    const keep = (part: string) => {
      bytes += Buffer.byteLength(part);
      if (bytes > limit) throw new Error("One chat history value exceeds its bounded rewrite limit");
      parts.push(part);
    };
    while (await this.ready()) {
      const start = this.position;
      while (this.position < this.text.length) {
        const character = this.text[this.position];
        if (primitive && !quoted && depth === 0 && /[\s,}\]]/.test(character)) {
          keep(this.text.slice(start, this.position));
          const result = parts.join(""); JSON.parse(result); return result;
        }
        this.position++;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') {
            quoted = false;
            if (depth === 0) { keep(this.text.slice(start, this.position)); const result = parts.join(""); JSON.parse(result); return result; }
          }
        } else if (character === '"') quoted = true;
        else if (character === "[" || character === "{") depth++;
        else if (character === "]" || character === "}") {
          depth--;
          if (depth === 0) { keep(this.text.slice(start, this.position)); const result = parts.join(""); JSON.parse(result); return result; }
        }
      }
      keep(this.text.slice(start));
    }
    if (primitive) { const result = parts.join(""); JSON.parse(result); return result; }
    throw new Error("Incomplete chat history JSON");
  }
}

export function rewriteChatHistory(
  response: Response,
  restore: (message: unknown) => unknown,
  replies: Array<Record<string, unknown>>,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  })();
  const input = new JsonInput(reader);
  // `at` counts backend messages, not other local replies. Equal positions keep
  // their stored order; missing/out-of-range positions append at the end.
  const local = replies.map((reply, order) => ({ reply, order, at: typeof reply.at === "number" && Number.isFinite(reply.at) ? Math.max(0, Math.trunc(reply.at)) : Infinity }))
    .sort((a, b) => a.at - b.at || a.order - b.order);
  async function* rewrite() {
    try {
      await input.expect("{"); yield "{";
      let firstField = true, seenMessages = false;
      while (await input.peek() !== "}") {
        if (!firstField) { await input.expect(","); yield ","; }
        firstField = false;
        const key = JSON.parse(await input.value(METADATA_MAX_BYTES));
        if (typeof key !== "string") throw new Error("Invalid chat history property");
        await input.expect(":"); yield JSON.stringify(key) + ":";
        if (key !== "messages") { yield await input.value(METADATA_MAX_BYTES); continue; }
        if (seenMessages) throw new Error("Duplicate chat history messages");
        seenMessages = true;
        await input.expect("["); yield "[";
        let index = 0, nextLocal = 0, firstOutput = true;
        function encode(value: unknown): string {
          const result = (firstOutput ? "" : ",") + JSON.stringify(value); firstOutput = false; return result;
        }
        function* insert(at: number) {
          while (nextLocal < local.length && local[nextLocal].at <= at) {
            const reply = local[nextLocal++].reply;
            yield encode({ role: "user", content: reply.prompt, requestId: reply.id });
            yield encode({ role: "assistant", content: reply.answer, requestId: reply.id });
          }
        }
        while (await input.peek() !== "]") {
          if (index) await input.expect(",");
          yield* insert(index);
          const message = JSON.parse(await input.value(HISTORY_MESSAGE_MAX_BYTES));
          yield encode(restore(message));
          index++;
        }
        yield* insert(Infinity);
        await input.expect("]"); yield "]";
      }
      await input.expect("}");
      if (await input.peek() !== undefined) throw new Error("Unexpected trailing chat history data");
      yield "}";
    } finally { await close(); }
  }
  const headers = new Headers(response.headers);
  for (const header of ["content-length", "content-encoding", "etag", "content-md5", "digest"])
    headers.delete(header);
  headers.set("cache-control", "no-store");
  const iterator = rewrite(), encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close(); else controller.enqueue(encoder.encode(result.value));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await close(); await iterator.return(); },
  });
  return new Response(stream,
    { status: response.status, statusText: response.statusText, headers });
}
