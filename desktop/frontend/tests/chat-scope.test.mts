import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DOCKED,
  chatIsDocked,
  chatQuery,
  scopeKey,
  scopeLabel,
} from "../app/lib/chat-scope.ts";
import { documentPath } from "../app/lib/routes.ts";

test("each document's chats are their own, and Memory's are the account's", () => {
  // The remount key is the whole mechanism by which another document swaps
  // threads instead of continuing one: a stream started beside one document
  // must never land in another's message array.
  const keys = [
    scopeKey({ context: "document", projectId: "p1", paperId: "d1" }),
    scopeKey({ context: "document", projectId: "p1", paperId: "d2" }),
    scopeKey({ context: "general" }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(scopeKey({ context: "general" }), "general");
});

test("only a document's chat docks in the address", () => {
  // Absence means no conversation is open, the Reader's resting state.
  assert.equal(CHAT_DOCKED, "paper");
  assert.ok(chatIsDocked("paper"));
  assert.ok(!chatIsDocked(null));
  // Memory is asked on its own page now, never docked beside a document.
  assert.ok(!chatIsDocked("general"));
  assert.ok(!chatIsDocked("project"));
  assert.ok(!chatIsDocked("nonsense"));
  assert.equal(documentPath("reader", { slug: "robotics" }, { slug: "lingbot" }), "/@reader/robotics/lingbot");
  assert.equal(
    documentPath("reader", { slug: "robotics" }, { slug: "lingbot" }, { chat: CHAT_DOCKED }),
    "/@reader/robotics/lingbot?chat=paper",
  );
});

test("the wire carries only the ids its scope can use", () => {
  // Memory names no document: nothing starts open beside it.
  assert.deepEqual(chatQuery({ context: "general" }), { scope: "general" });
  const document = { context: "document", projectId: "p1", paperId: "d1" } as const;
  assert.deepEqual(chatQuery(document), { scope: "document", project_id: "p1", paper_id: "d1" });
});

test("a context is named by how wide its question is", () => {
  // "Project", though the thread belongs to one document: the question is
  // answered with the whole project behind that document.
  assert.equal(scopeLabel("document"), "Project");
  assert.equal(scopeLabel("general"), "Memory");
});
