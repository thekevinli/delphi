import assert from "node:assert/strict";
import test from "node:test";

import {
  compactPaperMentionTitle,
  compactPaperMentionTokens,
  expandPaperMentionTokens,
  paperMentionToken,
} from "../app/lib/paper-mention.ts";

test("compacts paper mentions at the last whole word within a character budget", () => {
  assert.equal(
    compactPaperMentionTitle("alpha beta gamma delta echo", 25),
    "alpha beta gamma delta...",
  );
  assert.equal(
    compactPaperMentionTitle("alpha beta gamma delta xy zz", 25),
    "alpha beta gamma delta xy...",
  );
  assert.equal(
    paperMentionToken("How to Steal Reasoning Without Reasoning Traces"),
    "@How to Steal Reasoning Without...",
  );
});

test("keeps short titles and individual long words intact", () => {
  assert.equal(compactPaperMentionTitle("Kimi K3"), "Kimi K3");
  assert.equal(
    compactPaperMentionTitle("Antidisestablishmentarianism notes"),
    "Antidisestablishmentarianism...",
  );
});

test("compacts Chinese titles at locale-aware word boundaries", () => {
  assert.equal(
    paperMentionToken(
      "Transformer升级之路：2、博采众长的旋转式位置编码 - 科学空间",
    ),
    "@Transformer升级之路：2、博采众长的旋转式位置编码...",
  );
});

test("expands compact labels back to full titles for the model prompt", () => {
  const title = "How to Steal Reasoning Without Reasoning Traces";
  assert.equal(
    expandPaperMentionTokens(`Compare ${paperMentionToken(title)} please`, [{ title }]),
    `Compare @${title} please`,
  );
});

test("compacts stored full titles back into chips for an edit", () => {
  const title = "How to Steal Reasoning Without Reasoning Traces";
  assert.equal(
    compactPaperMentionTokens(`Compare @${title} please`, [{ title }]),
    `Compare ${paperMentionToken(title)} please`,
  );
});
