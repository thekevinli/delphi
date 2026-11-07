import assert from "node:assert/strict";
import test from "node:test";

import { parseSseFrames, readSseStream } from "../app/lib/sse.ts";

test("a whole frame is parsed and nothing is left over", () => {
  const { events, rest } = parseSseFrames('data: {"type":"delta","text":"hi"}\n\n');
  assert.deepEqual(events, [{ type: "delta", text: "hi" }]);
  assert.equal(rest, "");
});

test("several frames in one chunk come back in order", () => {
  const { events } = parseSseFrames(
    'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n',
  );
  assert.deepEqual(
    events.map((event) => event.n),
    [1, 2, 3],
  );
});

test("a half-written frame is held back rather than parsed", () => {
  // The exact case the hand-rolled loops existed to handle: a chunk boundary
  // that lands mid-JSON. Parsing it would throw on valid input.
  const { events, rest } = parseSseFrames('data: {"n":1}\n\ndata: {"n":2');
  assert.deepEqual(events, [{ n: 1 }]);
  assert.equal(rest, 'data: {"n":2');
});

test("a frame carried across two chunks parses once it completes", () => {
  const first = parseSseFrames('data: {"type":"del');
  assert.deepEqual(first.events, []);
  const second = parseSseFrames(`${first.rest}ta","text":"ok"}\n\n`);
  assert.deepEqual(second.events, [{ type: "delta", text: "ok" }]);
});

test("a frame with no data line is skipped, not treated as an error", () => {
  // Comment frames are legal SSE keep-alives; they must not stall the stream.
  const { events } = parseSseFrames(': keep-alive\n\ndata: {"n":7}\n\n');
  assert.deepEqual(events, [{ n: 7 }]);
});

test("the data line is found even when the frame names an event type first", () => {
  const { events } = parseSseFrames('event: message\ndata: {"n":8}\n\n');
  assert.deepEqual(events, [{ n: 8 }]);
});

test("unparseable JSON throws rather than being silently dropped", () => {
  assert.throws(() => parseSseFrames("data: not json\n\n"));
});

test("the stream reader yields every event across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"del',
    'ta","text":"b"}\n\n',
    'data: {"type":"done"}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const seen: unknown[] = [];
  for await (const event of readSseStream(body)) seen.push(event);
  assert.deepEqual(seen, [
    { type: "delta", text: "a" },
    { type: "delta", text: "b" },
    { type: "done" },
  ]);
});
