import assert from "node:assert/strict";
import test from "node:test";

import { conversationSource } from "../app/lib/account-menu.ts";

const conversation = (over: Record<string, unknown> = {}) => ({
  id: "c", title: "Title", lastEngagedAt: "2026-01-01T00:00:00Z",
  kind: "document_chat" as const, ...over,
});

test("a chat is labelled by what it is about, and the three scopes differ", () => {
  assert.deepEqual(
    conversationSource(conversation({
      projectName: "Scaling Law", paperTitle: "Chinchilla",
    })),
    ["Scaling Law", "Chinchilla"],
  );
  // A project chat ranges over the project, so it names no document even
  // though it carries `lastDocumentSlug` to have somewhere to land.
  assert.deepEqual(
    conversationSource(conversation({
      kind: "project_chat", projectName: "Scaling Law", paperTitle: null,
      lastDocumentSlug: "chinchilla",
    })),
    ["Scaling Law"],
  );
  // The wiki chat belongs to no project at all.
  assert.deepEqual(
    conversationSource(conversation({ kind: "memory_chat" })),
    ["Memory"],
  );
});

test("a chat whose project has gone still names something", () => {
  // Papers and projects are provenance; deleting one leaves the conversation
  // behind it, and a row with a blank where its collection should be reads as
  // a bug rather than as history.
  assert.deepEqual(
    conversationSource(conversation({ projectName: null, paperTitle: null })),
    ["Library"],
  );
});
