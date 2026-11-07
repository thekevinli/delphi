import assert from "node:assert/strict";
import test from "node:test";

import {
  availableContexts,
  chatIsDocked,
  chatParam,
  chatQuery,
  chatRequestScope,
  contextFromParam,
  defaultContext,
  scopeKey,
  scopeLabel,
} from "../app/lib/chat-scope.ts";
import { documentPath } from "../app/lib/routes.ts";

test("each context is its own conversation, and the key says so", () => {
  // The remount key is the whole mechanism by which switching context swaps
  // threads instead of continuing one. Two different contexts must never
  // produce the same key, or a stream started under one would land in the
  // other's message array.
  const keys = [
    scopeKey({ context: "document", projectId: "p1", paperId: "d1" }),
    scopeKey({ context: "document", projectId: "p1", paperId: "d2" }),
    scopeKey({ context: "general" }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  // The account-wide conversation is one thread for the whole account, so its
  // key may not vary with whatever happens to be open behind it — including
  // the document a Memory question names as context.
  assert.equal(scopeKey({ context: "general" }), "general");
  assert.equal(
    scopeKey({ context: "general", open: { projectId: "p1", paperId: "d1" } }),
    "general",
  );
});

test("a shell opens on the narrowest context it can actually mean", () => {
  assert.equal(defaultContext({ inReader: true, hasPaper: true }), "document");
  // Nothing open — an empty project, or the instant before the reader lands
  // on its first document: a Project question is asked beside a document, so
  // only Memory can honestly be meant.
  assert.equal(defaultContext({ inReader: true, hasPaper: false }), "general");
  assert.equal(defaultContext({ inReader: false, hasPaper: false }), "general");
});

test("there are two contexts, and Project needs a document open", () => {
  assert.deepEqual(availableContexts({ inReader: true, hasPaper: true }), [
    "document",
    "general",
  ]);
  assert.deepEqual(availableContexts({ inReader: true, hasPaper: false }), [
    "general",
  ]);
  // Off the reader there is no project either — only the account.
  assert.deepEqual(availableContexts({ inReader: false, hasPaper: false }), [
    "general",
  ]);
});

test("the URL spelling and the API spelling meet in exactly one place", () => {
  // Every context can say "and it is docked", including the document one —
  // that is the parameter's job. Absence means no conversation is open, which
  // is a different fact and the Reader's resting state.
  assert.equal(chatParam("document"), "paper");
  assert.equal(chatParam("general"), "general");
  assert.ok(!chatIsDocked(null));
  assert.ok(chatIsDocked("paper"));
  assert.ok(!chatIsDocked("nonsense"));

  const path = documentPath("reader", { slug: "robotics" }, { slug: "lingbot" });
  assert.equal(path, "/@reader/robotics/lingbot");
  assert.equal(
    documentPath("reader", { slug: "robotics" }, { slug: "lingbot" }, {
      chat: "paper",
    }),
    "/@reader/robotics/lingbot?chat=paper",
  );
  assert.equal(
    documentPath("reader", { slug: "robotics" }, { slug: "lingbot" }, {
      chat: "general",
    }),
    "/@reader/robotics/lingbot?chat=general",
  );
});

test("an address a stranger wrote is read, never thrown on", () => {
  // The retired project-wide link opens the conversation that replaced it.
  assert.equal(contextFromParam("project", { hasPaper: true }), "document");
  assert.ok(chatIsDocked("project"));
  assert.equal(contextFromParam("general", { hasPaper: true }), "general");
  assert.equal(contextFromParam(null, { hasPaper: true }), "document");
  // Nothing open, so the document context cannot be meant even if asked for.
  assert.equal(contextFromParam(null, { hasPaper: false }), "general");
  assert.equal(contextFromParam("project", { hasPaper: false }), "general");
  assert.equal(contextFromParam("nonsense", { hasPaper: false }), "general");
});

test("the wire carries only the ids its scope can legally use", () => {
  assert.deepEqual(chatRequestScope({ context: "general" }), {
    scope: "general",
  });
  assert.deepEqual(chatQuery({ context: "general" }), { scope: "general" });
  assert.deepEqual(
    chatQuery({ context: "document", projectId: "p1", paperId: "d1" }),
    { scope: "document", project_id: "p1", paper_id: "d1" },
  );
});

test("a Memory question names the open document, and its thread does not", () => {
  const beside = {
    context: "general",
    open: { projectId: "p1", paperId: "d1" },
  } as const;
  // On the question: the document whose digest and selection ride with it.
  assert.deepEqual(chatRequestScope(beside), {
    scope: "general",
    project_id: "p1",
    paper_id: "d1",
  });
  // On the thread: nothing. History, the catalog and the persona are the
  // account's, wherever the question was asked from.
  assert.deepEqual(chatQuery(beside), { scope: "general" });
  // Beside a Memory page instead, the page is named; a document wins over it.
  assert.deepEqual(chatRequestScope({ context: "general", page: "kv-cache" }), {
    scope: "general",
    page_slug: "kv-cache",
  });
  assert.ok(!("page_slug" in chatRequestScope({ ...beside, page: "kv-cache" })));
  // A project and a paper together or not at all; the server refuses half.
  assert.deepEqual(
    chatRequestScope({ context: "general", open: { projectId: "p1", paperId: "" } }),
    { scope: "general" },
  );
});

test("the pill names how wide the question is", () => {
  // "Project", though the thread belongs to one document: the question is
  // answered with the whole project behind that document.
  assert.equal(scopeLabel("document"), "Project");
  assert.equal(scopeLabel("general"), "Memory");
});
