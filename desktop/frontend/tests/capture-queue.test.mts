import assert from "node:assert/strict";
import test from "node:test";

import {
  drainCaptures,
  onCaptured,
  startCaptures,
  type Captured,
  type CapturePumpHost,
} from "../app/lib/capture-queue.ts";

const encoder = new TextEncoder();

function stream(frames: object[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.close();
      },
    }),
  );
}

const captured = (paperId: string, remaining = 0) => [
  { type: "progress", stage: "capture", paperId, projectId: "p" },
  { type: "done", claimed: true, paperId, projectId: "p", paper: { id: paperId, title: "Book" }, remaining },
];
const empty = (remaining = 0) => [{ type: "done", claimed: false, remaining }];

test("a drain reads each owed page whole, says which it read, and stops when none is due", async () => {
  const answers = [captured("a", 1), captured("b"), empty()];
  const seen: Captured[] = [];
  const stopHearing = onCaptured((done) => seen.push(done));
  let calls = 0;
  const fetcher = (async (url: string) => {
    assert.match(String(url), /\/api\/captures\/drain$/);
    return stream(answers[calls++]);
  }) as typeof fetch;
  try {
    await drainCaptures(fetcher);
  } finally {
    stopHearing();
  }
  assert.equal(calls, 3);
  assert.deepEqual(seen.map((done) => [done.paperId, done.paper?.id]), [["a", "a"], ["b", "b"]]);
});

test("a request during a drain is one drain, which claims again before it ends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const answers = [empty(), captured("late"), empty()];
  let calls = 0;
  const fetcher = (async () => {
    const answer = answers[calls++];
    if (calls === 1) await gate;
    return stream(answer);
  }) as typeof fetch;
  const first = drainCaptures(fetcher);
  // An add queued a capture just after the drain's empty claim was sent.
  const second = drainCaptures(fetcher);
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 3);
});

test("a capture that gives up is settled like one read whole", async () => {
  const answers = [
    [{ type: "error", paperId: "a", projectId: "p", terminal: true, paper: { id: "a", title: "Book" }, remaining: 0 }],
    empty(),
  ];
  const seen: Captured[] = [];
  const stop = onCaptured((done) => seen.push(done));
  let calls = 0;
  try {
    await drainCaptures((async () => stream(answers[calls++])) as typeof fetch);
  } finally {
    stop();
  }
  assert.deepEqual(seen.map((done) => done.paper?.id), ["a"]);
});

test("a failed capture is the server's to retry, and one still owed is asked for again later", async () => {
  const answers = [
    [{ type: "progress", paperId: "a" }, { type: "error", paperId: "a", retryAt: "later", terminal: false, remaining: 1 }],
    empty(1),
    empty(0),
  ];
  let calls = 0;
  const fetcher = (async () => stream(answers[calls++])) as typeof fetch;
  await drainCaptures(fetcher, 20);
  assert.equal(calls, 2);
  // A claim a quit app left behind frees when its lease runs out.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 3);
});

test("a drain the backend dropped mid-capture is asked for again once it is back", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return stream(empty());
  }) as typeof fetch;
  await assert.rejects(drainCaptures(fetcher, 20), /fetch failed/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 2);
});

test("the pump runs what a quit app left at launch, and again when the window is back", async () => {
  const handlers = new Map<string, () => void>();
  let visible = true;
  const host: CapturePumpHost = {
    addEventListener: (type, handler) => handlers.set(type, handler),
    isVisible: () => visible,
  };
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return stream(empty());
  }) as typeof fetch;
  startCaptures(host, fetcher);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  // Started once for the window, whoever asks.
  startCaptures(host, fetcher);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  visible = false;
  handlers.get("visibilitychange")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  visible = true;
  handlers.get("focus")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
});
