import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_RESULTS,
  MIN_QUERY,
  chipCounts,
  highlightMatches,
  moveSelection,
  searchHref,
  visibleResults,
} from "../app/lib/search.ts";
import type { SearchResult, SearchResults } from "../app/lib/search.ts";

const page = (over: Partial<SearchResult> = {}): SearchResult => ({
  kind: "memory",
  title: "Metaquery training",
  subtitle: "Retrieval",
  snippet: "",
  score: 1,
  occurrences: 1,
  slug: "metaquery-training",
  ...over,
});

const document = (over: Partial<SearchResult> = {}): SearchResult => ({
  kind: "document",
  title: "Unified retrieval",
  subtitle: "Diffusion · p. 4",
  snippet: "",
  score: 1,
  occurrences: 1,
  projectSlug: "diffusion",
  paperSlug: "unified-retrieval",
  locator: "4",
  locatorKind: "page",
  ...over,
});

const chat = (over: Partial<SearchResult> = {}): SearchResult => ({
  kind: "conversation",
  title: "On metaquery",
  subtitle: "Diffusion",
  snippet: "",
  score: 1,
  occurrences: 1,
  conversationId: "c1",
  conversationKind: "document_chat",
  projectSlug: "diffusion",
  paperSlug: "unified-retrieval",
  lastDocumentSlug: "unified-retrieval",
  ...over,
});

const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  memory: [page()],
  documents: [document()],
  conversations: [chat()],
  ...over,
});

test("a wiki page opens at its slug, which is the only address search invents", () => {
  assert.equal(
    searchHref("reader", page()),
    "/memory?page=metaquery-training",
  );
});

test("a document hit opens the reader at the place that matched", () => {
  // A page locator and an anchor are two different parameters, and getting
  // them the wrong way round lands the reader on page 1 of a long paper.
  assert.equal(
    searchHref("reader", document()),
    "/@reader/diffusion/unified-retrieval?focusPage=4",
  );
  assert.equal(
    searchHref(
      "reader",
      document({ locatorKind: "section", locator: "training-setup" }),
    ),
    "/@reader/diffusion/unified-retrieval?focusSection=training-setup",
  );
});

test("a conversation opens through the same rule the Dashboard already uses", () => {
  assert.equal(
    searchHref("reader", chat()),
    "/@reader/diffusion/unified-retrieval?chat=paper&conversation=c1",
  );
  // A project chat names the scope; a Memory chat has no document at
  // all and goes to the wiki's own conversation.
  assert.equal(
    searchHref("reader", chat({ conversationKind: "project_chat" })),
    "/@reader/diffusion/unified-retrieval?chat=project&conversation=c1",
  );
  assert.equal(
    searchHref("reader", chat({ conversationKind: "memory_chat" })),
    "/memory/graph?ask=1&conversation=c1",
  );
});

test("a row that cannot be addressed yields no href rather than a link to nowhere", () => {
  // A document whose project route is missing, and a page with no slug: both
  // are rendered as text instead of an anchor that 404s.
  assert.equal(searchHref("reader", document({ projectSlug: "" })), "");
  assert.equal(searchHref("reader", page({ slug: "" })), "");
});

test("the chips count what the list actually holds", () => {
  const counts = chipCounts(
    results({ documents: [document(), document()], conversations: [] }),
  );

  assert.equal(counts.memory, 1);
  assert.equal(counts.document, 2);
  assert.equal(counts.conversation, 0);
  // "All" is the sum, never a separately fetched number that could disagree.
  assert.equal(counts.all, 3);
  assert.deepEqual(chipCounts(EMPTY_RESULTS), {
    all: 0, memory: 0, document: 0, conversation: 0,
  });
});

test("the visible list is flat, and a chip narrows it to one kind", () => {
  const all = visibleResults(results(), "all");

  // Flat and in section order, which is what makes ↓ from the last Memory
  // hit land on the first document rather than stopping at a boundary.
  assert.deepEqual(all.map((hit) => hit.kind), [
    "memory", "document", "conversation",
  ]);
  assert.deepEqual(
    visibleResults(results(), "document").map((hit) => hit.kind),
    ["document"],
  );
});

test("the selection wraps at both ends and refuses to point at an empty list", () => {
  assert.equal(moveSelection(-1, 1, 3), 0);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  // Pressing an arrow with nothing found should stay nowhere.
  assert.equal(moveSelection(-1, 1, 0), -1);
  assert.equal(moveSelection(0, -1, 0), -1);
});

test("one character is a fragment, not a query", () => {
  // The gate that stops the first keystroke being a request against every
  // document in the account.
  assert.ok(MIN_QUERY >= 2);
});

test("a snippet bolds the case-insensitive match and leaves the rest alone", () => {
  const marked = highlightMatches(
    "Chen, Koustuv Sinha. Metamorph: Multimodal understanding.",
    "metamorph",
  )
    .filter((span) => span.match)
    .map((span) => span.text);

  assert.deepEqual(marked, ["Metamorph"]);
});

test("each query term is marked, including a prefix of a longer word", () => {
  // "pixel" is a prefix of PixelDiT the same way the ranker counts it, and
  // "diffusion" is a whole word. Painting anything else would claim a hit
  // the list would not have returned — or hide the one it did.
  const marked = highlightMatches(
    "PixelDiT presents a direct-RGB diffusion transformer",
    "pixel diffusion",
  )
    .filter((span) => span.match)
    .map((span) => span.text);

  assert.deepEqual(marked, ["Pixel", "diffusion"]);
});

test("a title match keeps the original casing", () => {
  const spans = highlightMatches("Pixel Diffusion — Domain Page", "pixel diffusion");

  assert.deepEqual(
    spans.filter((span) => span.match).map((span) => span.text),
    ["Pixel", "Diffusion"],
  );
  // The em dash and the rest of the title stay unmarked, so the match is
  // visible against type that is already semi-bold.
  assert.equal(
    spans.filter((span) => !span.match).map((span) => span.text).join(""),
    "  — Domain Page",
  );
});

test("stop words in the query are not a match of their own", () => {
  // The ranker drops them, so painting them would highlight a word the
  // search did not actually look for.
  const marked = highlightMatches("the pixel of diffusion", "the pixel of diffusion")
    .filter((span) => span.match)
    .map((span) => span.text);

  assert.deepEqual(marked, ["pixel", "diffusion"]);
});

test("an accented query still marks the folded word", () => {
  const marked = highlightMatches("renyi divergence", "Rényi")
    .filter((span) => span.match)
    .map((span) => span.text);

  assert.deepEqual(marked, ["renyi"]);
});
