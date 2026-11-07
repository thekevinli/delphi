import assert from "node:assert/strict";
import test from "node:test";

import {
  draftTokens,
  isResolvedPaperMention,
  paperMentionAt,
  splitComposerDraft,
  tokensPresent,
} from "../app/lib/composer-draft.ts";
import { paperMentionToken } from "../app/lib/paper-mention.ts";

const paper = (title: string) => ({ title }) as never;

test("the mention menu opens at a word boundary and nowhere else", () => {
  assert.deepEqual(paperMentionAt("tell me about @dif", 18), {
    start: 14,
    end: 18,
    query: "dif",
  });
  assert.deepEqual(paperMentionAt("@", 1), { start: 0, end: 1, query: "" });
  // Not mid-word: an address or a handle inside prose is not a document picker.
  assert.equal(paperMentionAt("mail me at reader@delphi", 24), null);
  // A mention the reader kept typing past still reports — the query simply
  // matches no document, so the menu closes on emptiness rather than on
  // position. Asserted because it is the behaviour, not an accident: a title
  // may contain spaces, so the query cannot stop at the first one.
  assert.deepEqual(paperMentionAt("@vae and then", 13), {
    start: 0,
    end: 13,
    query: "vae and then",
  });
});

test("a finished mention does not re-open the picker", () => {
  const papers = [paper("Attention Is All You Need")];
  const token = paperMentionToken("Attention Is All You Need");
  const text = `${token} `;
  const mention = { start: 0, end: text.length, query: "" };

  assert.ok(isResolvedPaperMention(text, mention, papers));
  // Still being typed: this must keep the picker open.
  assert.ok(
    !isResolvedPaperMention("@Atten", { start: 0, end: 6, query: "atten" }, papers),
  );
});

test("a draft is cut into prose and chips, earliest match first", () => {
  const tokens = ["@[Image #1]", "@Lingbot"];
  assert.deepEqual(
    splitComposerDraft("look at @[Image #1] beside @Lingbot please", tokens),
    [
      { kind: "text", value: "look at " },
      { kind: "token", value: "@[Image #1]" },
      { kind: "text", value: " beside " },
      { kind: "token", value: "@Lingbot" },
      { kind: "text", value: " please" },
    ],
  );
  assert.deepEqual(splitComposerDraft("", tokens), []);
  assert.deepEqual(splitComposerDraft("no mentions", tokens), [
    { kind: "text", value: "no mentions" },
  ]);
});

test("the longer of two overlapping titles wins its own chip", () => {
  // One document called "Attention" and another "Attention Is All You Need":
  // shortest-first would chip the first word and leave "Is All You Need"
  // outside as editable text, which reads as a half-deleted mention.
  const tokens = ["@Attention", "@AttentionIsAllYouNeed"];
  assert.deepEqual(splitComposerDraft("see @AttentionIsAllYouNeed here", tokens), [
    { kind: "text", value: "see " },
    { kind: "token", value: "@AttentionIsAllYouNeed" },
    { kind: "text", value: " here" },
  ]);
});

test("images and papers are both mention tokens", () => {
  const tokens = draftTokens([paper("LingBot VA")], [{ number: 2 }]);
  assert.ok(tokens.includes("@[Image #2]"));
  assert.ok(tokens.includes(paperMentionToken("LingBot VA")));
});

test("deleting a chip is noticed by its token going missing", () => {
  // This is how the composer knows to drop an attached image's thumbnail: the
  // reader deletes the chip, and the token stops appearing in the draft.
  const tokens = ["@[Image #1]", "@[Image #2]"];
  assert.deepEqual(tokensPresent("just @[Image #2] now", tokens), ["@[Image #2]"]);
  assert.deepEqual(tokensPresent("neither", tokens), []);
});
