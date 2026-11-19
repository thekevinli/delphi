import assert from "node:assert/strict";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { answerCitations, answerMarkdown, answerReferences, referenceSummary } from "../app/lib/answer-references.ts";
import { paperAliases } from "../app/lib/citations.ts";
import { knownPages } from "../app/lib/memory.ts";
import { sourceFor } from "../app/lib/web-sources.ts";

const pages = knownPages([
  { slug: "kv-cache", title: "KV cache reuse", kind: "concept", summary: "Reusing attention state across requests." },
  { slug: "serving", title: "Serving systems", kind: "domain" },
]);
const papers = [{ title: "Back to Basics - JiT (2511.13720v2)" }, { title: "PiD (2605.23902v1)" }] as Paper[];
const beside = { pages, papers, aliases: paperAliases(papers), current: "PiD (2605.23902v1)" };
const REPO = { url: "https://github.com/sgl-project/sglang-omni", title: "GitHub - sgl-project/sglang-omni: SGLang-Omni is a serving framework · GitHub" };
const DOCS = { url: "https://docs.vllm.ai/en/latest/features/disagg_prefill.html", title: "Disaggregated Prefilling - vLLM" };

test("the Memory pages an answer names are listed once each, by title, in the order it first names them", () => {
  const answer = [
    "This rests on [[serving]] and [[kv-cache]], and again on [[kv-cache|the cache]].",
    "It is not [[no-such-page]]. Code is literal: `[[serving]]`.",
    "See [the notes on [[serving]]](https://example.org/notes).",
  ].join("\n\n");
  const { memory } = answerReferences(answer, { pages });
  assert.deepEqual(memory.map(({ slug, title, kind, cited }) => ({ slug, title, kind, cited })), [
    { slug: "serving", title: "Serving systems", kind: "domain", cited: 1 },
    { slug: "kv-cache", title: "KV cache reuse", kind: "concept", cited: 2 },
  ]);
  assert.equal(memory[1].summary, "Reusing attention state across requests.");
  assert.equal(memory[0].summary, "");
});

test("a passage is listed where its citation can be followed, under the document its block is about", () => {
  const answer = [
    "## Results (Table 3, p. 2)",
    "",
    "JiT reports its ablation (Table 3, p. 2) and again later (Table 3, p. 2).",
    "",
    "| Run (p. 9) | Loss |",
    "|---|---|",
    "| base | 0.2 (p. 4) |",
    "",
    "The prior is trained at 2K (p. 7). See [the setup (p. 8)](https://example.org/setup).",
  ].join("\n");
  const { passages } = answerReferences(answer, beside);
  assert.deepEqual(passages.map(({ label, document, mark, cited }) => ({ label, document, mark, cited })), [
    { label: "Table 3", document: "Back to Basics - JiT (2511.13720v2)", mark: "2", cited: 2 },
    { label: "Page 4", document: "PiD (2605.23902v1)", mark: "4", cited: 1 },
    { label: "Page 7", document: "PiD (2605.23902v1)", mark: "7", cited: 1 },
  ]);
  assert.deepEqual(passages[0].target.pages, [2]);
  // A tight list item is drawn without its paragraph, so it reads the paper its whole item names.
  const tight = answerReferences("- The gain is large (p. 3)\n  - JiT trains at 256px.", beside).passages;
  assert.deepEqual(tight.map(({ label, document }) => ({ label, document })), [{ label: "Page 3", document: "Back to Basics - JiT (2511.13720v2)" }]);
  const loose = answerReferences("- The gain is large (p. 3)\n\n  JiT trains at 256px.\n\n- Next.", beside).passages;
  assert.equal(loose[0].document, "PiD (2605.23902v1)");
  // An answer in Memory has no document open to follow a page into.
  assert.deepEqual(answerReferences(answer, { pages }).passages, []);
});

test("a citation the model marked up is still a passage, and a page list reads as its runs", () => {
  // From a live answer, 2026-10-17: every citation italicised a title that
  // carries its arXiv id in parentheses, and the Sources list was empty.
  const vllm = [{ title: "vLLM-Omni tech report (2610.09307v1)", filename: "2610.09307v1.pdf" }] as Paper[];
  const answer = [
    "That boundary is explicit in the report. (*vLLM-Omni tech report (2610.09307v1)*, pp. 4–7.)",
    "",
    "Reproduce the hardware numbers. (*vLLM-Omni tech report (2610.09307v1)*, p. 24, Table 6.)",
    "",
    "- the transport **ablation** (*vLLM-Omni tech report (2610.09307v1)*, pp. 7, 10, 24).",
    "- its ranges (**vLLM-Omni tech report (2610.09307v1)**, pp. 1–2, 7–9)",
  ].join("\n");
  const { passages } = answerReferences(answer, { pages, papers: vllm, aliases: paperAliases(vllm) });
  assert.deepEqual(passages.map(({ label, document }) => ({ label, document })), [
    { label: "Pages 4–7", document: "vLLM-Omni tech report (2610.09307v1)" },
    { label: "Table 6", document: "vLLM-Omni tech report (2610.09307v1)" },
    { label: "Pages 7, 10, 24", document: "vLLM-Omni tech report (2610.09307v1)" },
    { label: "Pages 1–2, 7–9", document: "vLLM-Omni tech report (2610.09307v1)" },
  ]);
});

test("a web page is listed by what it is, says how often the answer cites it, and keeps an uncited source", () => {
  const answer = `The omni server is open ([github.com](${REPO.url})), and its design follows vLLM ([docs.vllm.ai](${DOCS.url})) ([github.com](${REPO.url})).`;
  const plain = { url: "https://example.org/", title: "Example Domain" };
  const { web } = answerReferences(answer, { pages, sources: [REPO, DOCS, plain] });
  assert.deepEqual(web, [
    { url: REPO.url, site: "github.com", title: "sgl-project/sglang-omni", detail: "SGLang-Omni is a serving framework", cited: 2 },
    { url: DOCS.url, site: "docs.vllm.ai", title: "Disaggregated Prefilling", detail: "en/latest/features/disagg_prefill.html", cited: 1 },
    { url: plain.url, site: "example.org", title: "Example Domain", detail: "", cited: 0 },
  ]);
});

test("an address is a source however it is encoded, in the text and in the list alike", () => {
  const wiki = { url: "https://de.wikipedia.org/wiki/Straße", title: "Straße – Wikipedia" };
  const encoded = "https://de.wikipedia.org/wiki/Stra%C3%9Fe";
  const { web } = answerReferences(`See ([de.wikipedia.org](${wiki.url})) and [again](${encoded}).`, { pages, sources: [wiki] });
  assert.equal(web[0].cited, 2);
  assert.equal(sourceFor(encoded, [wiki]), wiki);
  assert.equal(sourceFor(wiki.url, [{ ...wiki, url: encoded }])?.url, encoded);
});

test("the renderer and the list read one string, with a cited link out of its parentheses", () => {
  const content = `Open ([github.com](${REPO.url})) and (see [a note](https://example.org/n)).`;
  assert.equal(answerMarkdown(content, [REPO]), `Open [github.com](${REPO.url}) and (see [a note](https://example.org/n)).`);
  assert.equal(answerMarkdown(content, undefined), content);
});

test("the folded line names the kinds it holds, or for web pages alone, their sites", () => {
  const sources = Array.from({ length: 6 }, (_, n) => ({ url: `https://site${n % 4}.example.org/${n}`, title: `Page ${n}` }));
  assert.equal(referenceSummary(answerReferences("No links.", { pages, sources })), "6 pages · site0.example.org, site1.example.org +2");
  assert.equal(referenceSummary(answerReferences("No links.", { pages, sources: sources.slice(0, 1) })), "1 page · site0.example.org");
  const mixed = answerReferences("[[kv-cache]] and [[serving]], per JiT (p. 2).", { ...beside, sources: [REPO] });
  assert.equal(referenceSummary(mixed), "2 Memory pages · 1 passage · 1 web page");
});

test("a Memory answer lists the passages it cites anywhere in the library, and none it cannot open", () => {
  const library = [
    { id: "k", title: "Kimi K3: Open Agentic Intelligence (2611.02417v1)", filename: "kimi.pdf" },
    { id: "l", title: "LingBot-VA 2.0 (2610.18876v1)", filename: "lingbot.pdf" },
  ] as Paper[];
  const memory = { pages, papers: library, aliases: paperAliases(library) };
  const answer = [
    "1. **Kimi K3:** uses Per-Head Muon (§2.5, p. 10; §3.3, p. 11).",
    "2. **LingBot-VA 2.0:** a hybrid optimizer, `§4.1.2, p. 17`.",
    "3. Kaplan et al. fit it first (Kaplan et al., p. 5), ~~(p. 9)~~.",
  ].join("\n");
  assert.deepEqual(answerCitations(answer, memory).map(({ target, document }) => [target.text, document]), [
    ["§2.5, p. 10", "Kimi K3: Open Agentic Intelligence (2611.02417v1)"],
    ["§3.3, p. 11", "Kimi K3: Open Agentic Intelligence (2611.02417v1)"],
    ["§4.1.2, p. 17", "LingBot-VA 2.0 (2610.18876v1)"],
  ]);
  assert.equal(referenceSummary(answerReferences(answer, memory)), "3 passages");
});
