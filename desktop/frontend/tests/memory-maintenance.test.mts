import assert from "node:assert/strict";
import test from "node:test";

import {
  drainMemoryMaintenance,
  readerIsBeside,
  chatLeft,
  memoryStageDetail,
  memoryStages,
  onMemoryFiled,
  onMemoryQueue,
  onMemoryStage,
  startMemoryMaintenance,
  stopMemoryMaintenance,
  type MaintenancePumpHost,
} from "../app/lib/memory-maintenance.ts";

const encoder = new TextEncoder();

function streamResponse(chunks: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  );
}

/** One job, then an empty queue — the shape a drain sees when it is done. */
const CLAIMED = 'data: {"type":"done","claimed":true,"remaining":1}\n\n';
const EMPTY = 'data: {"type":"done","claimed":false,"remaining":0}\n\n';

test("maintenance draining is single-flight and consumes the terminal SSE frame", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = async () => {
    calls += 1;
    await gate;
    return streamResponse([
      'data: {"type":"progress","message":"filing"}\n\n',
      EMPTY,
    ]);
  };
  const first = drainMemoryMaintenance(fetcher as typeof fetch, 1);
  const second = drainMemoryMaintenance(fetcher as typeof fetch, 1);
  assert.equal(first, second);
  release();
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.last?.type, "done");
});

test("work that arrives during a long job starts at once instead of waiting behind it", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let secondStarted = false;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) {
      // The job the run is minutes into.
      await gate;
      return streamResponse([CLAIMED]);
    }
    if (calls === 2) {
      secondStarted = true;
      return streamResponse([CLAIMED]);
    }
    return streamResponse([EMPTY]);
  };
  const first = drainMemoryMaintenance(fetcher as typeof fetch, 3);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = drainMemoryMaintenance(fetcher as typeof fetch, 3);
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The first job has not finished, and the new one is already being run.
  assert.equal(secondStarted, true);
  release();
  const result = await first;
  assert.equal(result.processed, 2);
});

test("maintenance drains every queued job", async () => {
  const replies = [streamResponse([CLAIMED]), streamResponse([EMPTY])];
  let calls = 0;
  const result = await drainMemoryMaintenance((async () => {
    calls += 1;
    return replies.shift()!;
  }) as typeof fetch, 1);
  assert.equal(result.processed, 1);
  assert.equal(calls, 2);
});

test("one job's failure does not end the drain", async () => {
  // The queue is claimed in order, so a drain that stopped at the first bad
  // document never reached any document behind it — on this mount or on any
  // later one. The failure is already durable on the server; the loop's job is
  // to keep going.
  const replies = [
    streamResponse([
      'data: {"type":"error","jobId":"a","message":"provider unavailable"}\n\n',
    ]),
    streamResponse([CLAIMED]),
    streamResponse([EMPTY]),
  ];
  let calls = 0;
  const result = await drainMemoryMaintenance((async () => {
    calls += 1;
    return replies.shift()!;
  }) as typeof fetch, 1);
  assert.equal(calls, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.processed, 1);
});

test("a drain that cannot reach the queue at all still throws", async () => {
  await assert.rejects(
    drainMemoryMaintenance((async () => streamResponse([], 503)) as typeof fetch, 1),
    /503/,
  );
});

test("an empty queue costs one request, however many workers are allowed", async () => {
  // The pump asks every five minutes for the life of the session, and almost
  // every one of those finds nothing to do. Fanning out first would multiply
  // the commonest case by the worker count.
  let calls = 0;
  const result = await drainMemoryMaintenance((async () => {
    calls += 1;
    return streamResponse([EMPTY]);
  }) as typeof fetch, 3);
  assert.equal(calls, 1);
  assert.equal(result.processed, 0);
});

test("workers run jobs at once and stop together when the queue empties", async () => {
  // The server hands each claim a distinct job (`FOR UPDATE SKIP LOCKED`), so
  // concurrency is the client's decision alone. What matters here is that the
  // workers overlap and that an empty queue stops all of them rather than
  // leaving two spinning.
  let inFlight = 0;
  let peak = 0;
  let served = 0;
  const fetcher = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    served += 1;
    return streamResponse([served <= 6 ? CLAIMED : EMPTY]);
  };
  const result = await drainMemoryMaintenance(fetcher as typeof fetch, 3);
  assert.equal(peak, 3);
  assert.equal(result.processed, 6);
});

test("a filed document notifies whoever is watching the wiki", async () => {
  // Several places start a drain and only one of them is the surface the reader
  // is looking at, so the news travels by subscription rather than by each
  // caller remembering to pass a callback.
  const seen: number[] = [];
  const stop = onMemoryFiled(() => seen.push(seen.length));
  const replies = [streamResponse([CLAIMED]), streamResponse([CLAIMED]), streamResponse([EMPTY])];
  await drainMemoryMaintenance((async () => replies.shift()!) as typeof fetch, 1);
  // One per job, so a long backlog fills the view as it lands.
  assert.equal(seen.length, 2);

  stop();
  await drainMemoryMaintenance((async () =>
    streamResponse([CLAIMED])) as typeof fetch, 1).catch(() => undefined);
  assert.equal(seen.length, 2);
});

test("a job starting or failing tells whoever is showing the queue", async () => {
  let heard = 0;
  const stop = onMemoryQueue(() => { heard += 1; });
  let heardWhenFirstJobEnded = -1;
  const replies = [
    // A job that reports a stage, then finishes.
    () => streamResponse(['data: {"type":"progress","jobId":"a","message":"Planning"}\n\n', CLAIMED]),
    // One that fails.
    () => streamResponse(['data: {"type":"error","jobId":"b","message":"provider"}\n\n']),
    () => streamResponse([EMPTY]),
  ];
  const stopFiled = onMemoryFiled(() => { heardWhenFirstJobEnded = heard; });
  await drainMemoryMaintenance((async () => replies.shift()!()) as typeof fetch, 1);
  stop();
  stopFiled();
  // Heard once before the first job was filed, and again for the failure. The
  // empty claim that ends the drain is not a change.
  assert.equal(heardWhenFirstJobEnded, 1);
  assert.equal(heard, 3);
});

test("a watcher that throws does not take the queue down", async () => {
  const stop = onMemoryFiled(() => {
    throw new Error("a view failed to refresh");
  });
  try {
    const replies = [streamResponse([CLAIMED]), streamResponse([EMPTY])];
    const result = await drainMemoryMaintenance(
      (async () => replies.shift()!) as typeof fetch,
      1,
    );
    assert.equal(result.processed, 1);
  } finally {
    stop();
  }
});


test("the tab running a job publishes what it is doing, and clears it when it ends", async () => {
  // The queue row cannot carry a stage — only the browser holding the stream
  // knows one — so without this the card's fallback stood for the whole of a
  // filing and every row read as hung minutes into normal work.
  const seen: string[] = [];
  let notices = 0;
  const stop = onMemoryStage(() => {
    notices += 1;
    const stage = memoryStages().get("j7");
    if (stage) seen.push(stage);
  });
  const replies = [
    streamResponse([
      'data: {"type":"progress","jobId":"j7","message":"Planning how to teach it"}\n\n',
      'data: {"type":"progress","jobId":"j7","message":"Writing the pages"}\n\n',
      'data: {"type":"done","claimed":true,"jobId":"j7","remaining":0}\n\n',
    ]),
    streamResponse([EMPTY]),
  ];
  await drainMemoryMaintenance((async () => replies.shift()!) as unknown as typeof fetch, 1);
  stop();
  assert.deepEqual(seen, ["Planning how to teach it", "Writing the pages"]);
  // The last stage of a finished document must not sit under the next one's
  // title when the row list shifts.
  assert.equal(memoryStages().has("j7"), false);
  assert.equal(notices, 3);
});

test("a running job's step only moves forward, and a named step is taken at its word", async () => {
  const steps: number[] = [];
  const stop = onMemoryStage(() => {
    const detail = memoryStageDetail("j9");
    if (detail) steps.push(detail.step);
  });
  const replies = [
    streamResponse([
      'data: {"type":"progress","jobId":"j9","message":"Reading the document"}\n\n',
      'data: {"type":"progress","jobId":"j9","message":"Planning how to teach it"}\n\n',
      'data: {"type":"progress","jobId":"j9","message":"Writing the pages"}\n\n',
      // Re-reading a table while writing is still writing.
      'data: {"type":"progress","jobId":"j9","message":"Reading page 7"}\n\n',
      // A pass that names its step outright wins over the wording.
      'data: {"type":"progress","jobId":"j9","step":"check","message":"Something new"}\n\n',
      'data: {"type":"done","claimed":true,"jobId":"j9","remaining":0}\n\n',
    ]),
    streamResponse([EMPTY]),
  ];
  await drainMemoryMaintenance((async () => replies.shift()!) as unknown as typeof fetch, 1);
  stop();
  assert.deepEqual(steps, [0, 1, 2, 2, 3]);
  assert.equal(memoryStageDetail("j9"), undefined);
});

test("a filing that opens with its digest is on the first step, not the last", async () => {
  const steps: number[] = [];
  const stop = onMemoryStage(() => {
    const detail = memoryStageDetail("j10");
    if (detail) steps.push(detail.step);
  });
  const replies = [
    streamResponse([
      // What a real pass sends first: the digest's own checking and writing.
      'data: {"type":"progress","jobId":"j10","stage":"digest_check","message":"Checking Adam"}\n\n',
      'data: {"type":"progress","jobId":"j10","stage":"digest_check","message":"Summarizing Adam"}\n\n',
      'data: {"type":"progress","jobId":"j10","stage":"model_stream","message":"Writing the digest · 900 characters"}\n\n',
      'data: {"type":"progress","jobId":"j10","stage":"memory_select","message":"Deciding where Adam belongs in Memory"}\n\n',
      'data: {"type":"progress","jobId":"j10","stage":"memory_maintain","message":"Reading Memory and writing what belongs in it"}\n\n',
      'data: {"type":"progress","jobId":"j10","stage":"memory_verify","message":"Checking what was written against its sources"}\n\n',
      'data: {"type":"done","claimed":true,"jobId":"j10","remaining":0}\n\n',
    ]),
    streamResponse([EMPTY]),
  ];
  await drainMemoryMaintenance((async () => replies.shift()!) as unknown as typeof fetch, 1);
  stop();
  assert.deepEqual(steps, [0, 0, 0, 1, 2, 3]);
});

// Each tick and each report is fire-and-forget, so settle before reading.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

type FakeHost = {
  visible: boolean;
  interval: null | (() => void);
  cleared: boolean;
  fire: (type: string) => void;
  api: MaintenancePumpHost;
};

/** A pump host whose clock and visibility the test owns. */
function fakeHost(visible = true): FakeHost {
  const listeners = new Map<string, () => void>();
  const host: FakeHost = {
    visible,
    interval: null as null | (() => void),
    cleared: false,
    fire(type: string) {
      listeners.get(type)?.();
    },
    api: {
      setInterval: (handler: () => void) => {
        host.interval = handler;
        return 1;
      },
      clearInterval: () => {
        host.cleared = true;
      },
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, handler);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
      isVisible: () => host.visible,
    },
  };
  return host;
}

test("the pump drains on start, on focus, on visibility and on its interval", async () => {
  // Before this existed nothing re-drained after the first mount: a job that
  // failed and backed off for thirty minutes waited for the reader to navigate
  // somewhere before anything retried it.
  const host = fakeHost();
  let calls = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/sessions/release")) return Response.json({ released: 0 });
    calls += 1;
    return streamResponse([EMPTY]);
  }) as typeof fetch;

  try {
    startMemoryMaintenance(true, host.api, fetcher);
    await settle();
    assert.equal(calls, 1, "starting the pump asks once");

    host.fire("focus");
    await settle();
    assert.equal(calls, 2);

    host.fire("visibilitychange");
    await settle();
    assert.equal(calls, 3);

    host.interval?.();
    await settle();
    assert.equal(calls, 4);

    // A hidden tab is not the one the reader is watching, and a background tab
    // spending model calls is a surprise on the bill.
    host.visible = false;
    host.interval?.();
    host.fire("focus");
    await settle();
    assert.equal(calls, 4, "nothing ran while hidden");
  } finally {
    stopMemoryMaintenance();
  }
});

test("starting the pump twice does not mean two intervals", async () => {
  const first = fakeHost();
  const second = fakeHost();
  const fetcher = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/sessions/release") ? Response.json({ released: 0 }) : streamResponse([EMPTY])
  ) as typeof fetch;
  try {
    startMemoryMaintenance(true, first.api, fetcher);
    startMemoryMaintenance(true, second.api, fetcher);
    assert.ok(first.interval, "the first start armed the pump");
    assert.equal(second.interval, null, "the second was a no-op");
    await settle();
  } finally {
    stopMemoryMaintenance();
  }
  assert.equal(first.cleared, true);
});

test("the pump does nothing when Memory is turned off", () => {
  const host = fakeHost();
  startMemoryMaintenance(false, host.api);
  assert.equal(host.interval, null);
  stopMemoryMaintenance();
});


/** A backend that records what it is asked, in order, and holds `held` waiting sessions. */
function recordingBackend(held = 1) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/sessions/release")) {
      asked.push(`release ${typeof init?.body === "string" ? init.body : "all"}`);
      return Response.json({ released: held });
    }
    asked.push("drain");
    return streamResponse([EMPTY]);
  }) as typeof fetch;
  return { asked, fetcher };
}

test("launch releases every waiting session before the first drain, once for a window", async () => {
  // Closing the window reports nothing, so a session ended that way is still
  // held. At launch none is open, and the first drain can claim them all.
  const { asked, fetcher } = recordingBackend();
  try {
    startMemoryMaintenance(true, fakeHost().api, fetcher);
    assert.deepEqual(asked, ["release all"], "the drain waits for the release");
    await settle();
    assert.deepEqual(asked, ["release all", "drain"]);
    // A shell that mounts later finds the pump running; nothing has ended since.
    startMemoryMaintenance(true, fakeHost().api, fetcher);
    await settle();
    assert.deepEqual(asked, ["release all", "drain"]);
  } finally {
    stopMemoryMaintenance();
  }
});

test("leaving a document or a Memory chat releases its session and runs the queue", async () => {
  const { asked, fetcher } = recordingBackend();
  const chat = "0123456789abcdef0123456789abcdef";
  try {
    startMemoryMaintenance(true, fakeHost().api, fetcher);
    await settle();
    asked.length = 0;

    // Opening a document, and its chat, ends nothing.
    readerIsBeside({ document: { paperId: "p1", projectId: "j1", chat: false } }, fetcher);
    readerIsBeside({ document: { paperId: "p1", projectId: "j1", chat: true } }, fetcher);
    await settle();
    assert.deepEqual(asked, []);

    // Another document takes its place.
    readerIsBeside({ document: { paperId: "p2", projectId: "j1", chat: true } }, fetcher);
    await settle();
    assert.deepEqual(asked, ['release {"paperId":"p1","projectId":"j1"}', "drain"]);

    // A Memory chat opens beside it and is left; the document stays.
    asked.length = 0;
    readerIsBeside({ conversationId: chat }, fetcher);
    readerIsBeside({ conversationId: null }, fetcher);
    await settle();
    assert.deepEqual(asked, [`release {"conversationId":"${chat}"}`, "drain"]);

    // The reader leaves the reader altogether.
    asked.length = 0;
    readerIsBeside({ document: null }, fetcher);
    await settle();
    assert.deepEqual(asked, ['release {"paperId":"p2","projectId":"j1"}', "drain"]);
  } finally {
    stopMemoryMaintenance();
  }
});

test("a Memory chat remounted beside another view is not a chat the reader left", async () => {
  const { asked, fetcher } = recordingBackend();
  const chat = "0123456789abcdef0123456789abcdef";
  try {
    startMemoryMaintenance(true, fakeHost().api, fetcher);
    await settle();
    asked.length = 0;

    // The page's chat unmounts and the map's mounts on the same conversation.
    readerIsBeside({ conversationId: chat }, fetcher);
    chatLeft(fetcher, 20);
    readerIsBeside({ conversationId: chat }, fetcher);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(asked, []);

    // Nothing comes back: once the grace passes, the conversation is released.
    chatLeft(fetcher, 20);
    await new Promise(resolve => setTimeout(resolve, 40));
    await settle();
    assert.deepEqual(asked, [`release {"conversationId":"${chat}"}`, "drain"]);
  } finally {
    stopMemoryMaintenance();
  }
});

test("a release that freed nothing asks for no drain, and a failed one breaks nothing", async () => {
  const quiet = recordingBackend(0);
  try {
    startMemoryMaintenance(true, fakeHost().api, quiet.fetcher);
    await settle();
    quiet.asked.length = 0;
    readerIsBeside({ document: { paperId: "p1", projectId: "j1", chat: false } }, quiet.fetcher);
    readerIsBeside({ document: null }, quiet.fetcher);
    await settle();
    assert.deepEqual(quiet.asked, ['release {"paperId":"p1","projectId":"j1"}']);

    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    try {
      const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
      readerIsBeside({ document: { paperId: "p1", projectId: "j1", chat: false } }, down);
      assert.doesNotThrow(() => readerIsBeside({ document: null }, down));
      await settle();
      assert.equal(warned.length, 1, "logged, not shown");
    } finally {
      console.warn = warn;
    }
  } finally {
    stopMemoryMaintenance();
  }
});

test("nothing is reported before the pump starts", async () => {
  const { asked, fetcher } = recordingBackend();
  // Memory turned off: the pump never started.
  readerIsBeside({ document: { paperId: "p1", projectId: "j1", chat: true } }, fetcher);
  readerIsBeside({ document: null }, fetcher);
  await settle();
  assert.deepEqual(asked, []);
});
