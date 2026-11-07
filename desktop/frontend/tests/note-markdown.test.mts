import assert from "node:assert/strict";
import test from "node:test";

import {
  docToMarkdown,
  markdownToDoc,
  noteSummary,
  type Node,
} from "../app/lib/note-markdown.ts";

/** What the editor holds after typing `markdown`, back as markdown. */
const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

test("what the toolbar can produce survives a round trip", () => {
  for (const source of [
    "a plain thought",
    "**bold** and _italic_ and `code`",
    "compare against [the SSD-LM paper](https://arxiv.org/abs/2210.17432)",
    "- first\n- second\n- third",
    "1. first\n2. second",
    "> worth revisiting",
    "# a heading",
    "**bold with _italic_ inside**",
  ]) {
    assert.equal(roundTrip(source), source, `round trip failed for: ${source}`);
  }
});

test("a paragraph and a hard break are different things", () => {
  // Enter makes a paragraph, Shift+Enter a break inside one. A round trip that
  // conflated them would silently rewrite the reader's own line spacing.
  const broken = markdownToDoc("first line  \nsecond line");
  assert.equal(broken.content?.length, 1);
  assert.ok(broken.content?.[0].content?.some((node) => node.type === "hardBreak"));

  const separate = markdownToDoc("first line\n\nsecond line");
  assert.equal(separate.content?.length, 2);
});

test("emphasis characters in prose are escaped rather than read back as syntax", () => {
  const doc: Node = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "a * b _ c" }] }],
  };
  const markdown = docToMarkdown(doc);
  assert.equal(markdown, "a \\* b \\_ c");
  assert.equal(
    markdownToDoc(markdown).content?.[0].content?.[0].text,
    "a * b _ c",
  );
});

test("code is literal, so emphasis inside it is text and never a wrapper", () => {
  const doc: Node = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "x_i * 2", marks: [{ type: "code" }, { type: "bold" }] },
        ],
      },
    ],
  };
  // The backticks are innermost: `**`x_i * 2`**` would show the asterisks.
  assert.equal(docToMarkdown(doc), "**`x_i * 2`**");
});

test("a link keeps its href and its inner emphasis", () => {
  const parsed = markdownToDoc("see [**MDLM**](https://example.com/p) for this");
  const marks = parsed.content?.[0].content?.[1].marks ?? [];
  assert.deepEqual(
    marks.map((mark) => mark.type).sort(),
    ["bold", "link"],
  );
  assert.equal(
    marks.find((mark) => mark.type === "link")?.attrs?.href,
    "https://example.com/p",
  );
});

test("an empty note is empty rather than a stray paragraph", () => {
  assert.equal(docToMarkdown({ type: "doc", content: [] }), "");
  assert.equal(docToMarkdown({ type: "doc", content: [{ type: "paragraph" }] }), "");
  assert.equal(docToMarkdown(null), "");
});

test("the collapsed label strips syntax rather than rendering it", () => {
  assert.equal(
    noteSummary("- compare against [SSD-LM](https://example.com) on **Table 2**"),
    "compare against SSD-LM on Table 2",
  );
  assert.equal(noteSummary("a".repeat(200)).length, 90);
  assert.ok(noteSummary("a".repeat(200)).endsWith("…"));
});
