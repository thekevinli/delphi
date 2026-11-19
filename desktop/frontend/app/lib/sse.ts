/**
 * One reader for every Delphi SSE stream.
 *
 * Chat, the digest build, the Memory backfill and the Memory chat all
 * consume the same wire format — frames separated by a blank line, one `data:`
 * line each, a JSON object inside. Each of them had grown its own copy of the
 * `getReader()` + `TextDecoder` + `split("\n\n")` + `slice(5)` loop, and the
 * copies had already drifted in their variable names and their handling of the
 * trailing partial frame. A parser bug in one of four places is a bug nobody
 * finds, because the other three keep working.
 *
 * Split in two on purpose: `parseSseFrames` is pure and therefore unit-testable
 * without a network, and `readSseStream` is the thin transport wrapper around
 * it. The framing rules — not the fetch — are what is worth testing.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it directly.
 */

/**
 * One decoded frame.
 *
 * Deliberately loose. Every producer is one of Delphi's own routers and the
 * vocabulary is small and typed on that side (`delta` / `reasoning` /
 * `reasoning_break` / `status` / `progress` / `done` / `error`), but the fields
 * carried differ per event and per route — a `progress` from the digest builder
 * and one from the chat stream share only their `type`. Narrowing here would
 * mean one union that every route has to be added to, which is how a new event
 * ends up silently dropped. Callers narrow on `type` at the point of use, which
 * is exactly what they did when each hand-rolled loop called `JSON.parse`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SseEvent = { type?: string } & Record<string, any>;

/**
 * Split whatever complete frames the buffer holds, returning the unfinished
 * remainder for the caller to keep accumulating into.
 *
 * A frame with no `data:` line is skipped rather than reported: the format
 * allows comment lines (`: keep-alive`) and event-type lines, and none of
 * Delphi's producers send a payload without `data:`. A malformed payload does
 * throw, which is deliberate and matches what every hand-rolled copy did — a
 * stream that has started emitting unparseable JSON is not one to keep reading.
 */
export function parseSseFrames(buffer: string): {
  events: SseEvent[];
  rest: string;
} {
  const frames = buffer.split("\n\n");
  // The last piece is whatever arrived after the final blank line, which is
  // usually half a frame. It goes back to the caller rather than being parsed.
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) continue;
    events.push(JSON.parse(line.slice(5)));
  }
  return { events, rest };
}

/**
 * Yield each event of a streaming response in order.
 *
 * The caller owns cancellation through the `AbortSignal` it passed to `fetch`;
 * aborting rejects the pending `read()`, which propagates out of the loop the
 * same way it did when each caller wrote this by hand.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseFrames(buffer);
    buffer = rest;
    for (const event of events) yield event;
  }
}
