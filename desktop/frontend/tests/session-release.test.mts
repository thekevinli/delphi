import assert from "node:assert/strict";
import test from "node:test";

import {
  EVERY_SESSION,
  NOWHERE,
  releasesFor,
  sendSessionRelease,
  type Beside,
} from "../app/lib/session-release.ts";

const CHAT = "0123456789abcdef0123456789abcdef";
const OTHER_CHAT = "fedcba9876543210fedcba9876543210";

const beside = (paperId: string | null, chat = false, conversationId: string | null = null): Beside => ({
  document: paperId ? { paperId, projectId: "proj", chat } : null,
  conversationId,
});

test("arriving somewhere ends nothing", () => {
  assert.deepEqual(releasesFor(NOWHERE, beside("a")), []);
  assert.deepEqual(releasesFor(NOWHERE, beside("a", true)), []);
  assert.deepEqual(releasesFor(NOWHERE, beside(null, false, CHAT)), []);
  assert.deepEqual(releasesFor(NOWHERE, NOWHERE), []);
});

test("a document's session ends when another document takes its place or the reader leaves it", () => {
  const left = [{ paperId: "a", projectId: "proj" }];
  assert.deepEqual(releasesFor(beside("a", true), beside("b", true)), left);
  assert.deepEqual(releasesFor(beside("a", true), NOWHERE), left);
  // Notes belong to the session too, so a document whose chat was never
  // opened is still one the reader can leave.
  assert.deepEqual(releasesFor(beside("a"), beside("b")), left);
  assert.deepEqual(releasesFor(beside("a"), NOWHERE), left);
});

test("closing a document's chat ends its session; opening it and staying do not", () => {
  assert.deepEqual(releasesFor(beside("a", true), beside("a", false)), [{ paperId: "a", projectId: "proj" }]);
  assert.deepEqual(releasesFor(beside("a", false), beside("a", true)), []);
  // Moving between the chats beside one document changes nothing here.
  assert.deepEqual(releasesFor(beside("a", true), beside("a", true)), []);
  assert.deepEqual(releasesFor(beside("a", false), beside("a", false)), []);
});

test("a chat with no document ends when it leaves the screen", () => {
  assert.deepEqual(releasesFor(beside(null, false, CHAT), NOWHERE), [{ conversationId: CHAT }]);
  assert.deepEqual(releasesFor(beside(null, false, CHAT), beside(null, false, OTHER_CHAT)), [{ conversationId: CHAT }]);
  assert.deepEqual(releasesFor(beside(null, false, CHAT), beside(null, false, CHAT)), []);
  // Asked beside a document that stays open: only the chat ended.
  assert.deepEqual(releasesFor(beside("a", false, CHAT), beside("a", false)), [{ conversationId: CHAT }]);
  // The route changed under both.
  assert.deepEqual(releasesFor(beside("a", false, CHAT), NOWHERE), [
    { paperId: "a", projectId: "proj" },
    { conversationId: CHAT },
  ]);
});

test("an id the server would refuse is never sent", () => {
  // A chat not yet created is a draft with a local id, and has nothing to file.
  assert.deepEqual(releasesFor(beside(null, false, "draft-3f2a"), NOWHERE), []);
  assert.deepEqual(releasesFor(beside("not an id"), NOWHERE), []);
  assert.deepEqual(
    releasesFor({ document: { paperId: "a", projectId: "", chat: true }, conversationId: null }, NOWHERE),
    [],
  );
});

test("a release posts what ended, and no body for every session", async () => {
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return Response.json({ released: 2 });
  }) as typeof fetch;

  assert.equal(await sendSessionRelease({ paperId: "a", projectId: "proj" }, fetcher), 2);
  assert.equal(await sendSessionRelease({ conversationId: CHAT }, fetcher), 2);
  assert.equal(await sendSessionRelease(EVERY_SESSION, fetcher), 2);

  assert.ok(sent.every((request) => request.url.endsWith("/api/memory/sessions/release")));
  assert.ok(sent.every((request) => request.init?.method === "POST" && request.init.credentials === "include"));
  assert.equal(sent[0].init?.body, '{"paperId":"a","projectId":"proj"}');
  assert.equal(sent[1].init?.body, `{"conversationId":"${CHAT}"}`);
  assert.equal(sent[2].init?.body, undefined);
  assert.equal(sent[2].init?.headers, undefined);
});

test("a release that fails answers zero and never throws", async () => {
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const refused = (async () => new Response("off", { status: 403 })) as typeof fetch;
    const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const garbled = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    assert.equal(await sendSessionRelease(EVERY_SESSION, refused), 0);
    assert.equal(await sendSessionRelease(EVERY_SESSION, down), 0);
    assert.equal(await sendSessionRelease(EVERY_SESSION, garbled), 0);
    assert.equal(warned.length, 3);
  } finally {
    console.warn = warn;
  }
});
