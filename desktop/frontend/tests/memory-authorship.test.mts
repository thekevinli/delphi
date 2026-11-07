import assert from "node:assert/strict";
import test from "node:test";
import { authorDate, authorName } from "../app/lib/memory-authorship.ts";
import type { MemoryAuthor } from "../app/lib/api.ts";

const author = (kind: MemoryAuthor["kind"], title: string | null, removed = false): MemoryAuthor =>
  ({ kind, id: "x", projectId: removed ? null : "p", title, firstAt: "2026-09-12T10:00:00Z", note: null, removed });

test("a row is named for the document, the chats and notes beside one, or the Memory chat", () => {
  assert.equal(authorName(author("document", "LLaDA")), "LLaDA");
  assert.equal(authorName(author("session", "MMaDA")), "Chats and notes beside MMaDA");
  assert.equal(authorName(author("chat", "Which tricks stack?")), "Memory chat: Which tricks stack?");
});

test("an author removed before its event kept a name is named for what it was", () => {
  assert.equal(authorName(author("document", null, true)), "A document no longer in your library");
  assert.equal(authorName(author("session", null, true)), "A document no longer in your library");
  assert.equal(authorName(author("chat", null, true)), "A deleted Memory chat");
});

test("a date is the month and day, and the year only when it is not this one", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  assert.equal(authorDate("2026-09-12T10:00:00Z", now), "Sep 12");
  assert.equal(authorDate("2025-09-12T10:00:00Z", now), "Sep 12, 2025");
  assert.equal(authorDate("not a date", now), "");
});
