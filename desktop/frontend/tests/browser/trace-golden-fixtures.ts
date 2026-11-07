import type { AnswerTrace } from "../../app/lib/answer-trace.ts";
import { traceAnswer, traceFixture, traceRunning, traceWorkedOnly } from "./trace-fixture.ts";

/**
 * The traces whose rendering is pinned (`trace-golden.spec.ts`).
 *
 * Every state the trace was designed for, then one stored trace per row of the
 * tool-sequence matrix, so each tool is drawn alone and inside a realistic
 * chain. They are stored records, as the backend writes them: the golden says
 * what a reader sees for each. A change to a tool's name or to what a call
 * keeps is made here and must leave the golden's visible text alone unless the
 * change was meant to be seen.
 */
export type TraceGoldenCase = {
  name: string;
  content: string;
  trace: AnswerTrace;
  /** Drawn as the answer being written, this many milliseconds in. */
  liveFor?: number;
};

const MUP = { paperId: "a06f31c2", title: "Tensor Programs V", kind: "pdf" };
const NTK = { paperId: "b17e42d3", title: "Neural Tangent Kernel", kind: "pdf" };
const ARTICLE = { paperId: "c28f53e4", title: "Scaling laws, explained", kind: "web-page" };
const ABC = { slug: "abc-parametrization", title: "abc-parametrization", kind: "concept" };
const KERNEL = { slug: "kernel-regime", title: "Kernel regime", kind: "concept" };
const FEATURE = { slug: "feature-learning-in-infinite-width-networks", title: "Feature Learning in Infinite-Width Neural Networks", kind: "source" };
const DOMAIN = { slug: "deep-learning-theory", title: "Deep learning theory", kind: "domain" };
const WIDTH = { slug: "why-sp-fails-at-width", title: "Why standard parametrization fails at width", kind: "concept" };

const ARXIV = "https://arxiv.org/abs/2203.03466";
/** What a search consulted: an address and its site. The provider gives no title here. */
const consulted = (...urls: string[]) => urls.map((url) => ({ url, title: new URL(url).hostname.replace(/^www\./, ""), kind: "web" }));

const document = { start: { kind: "document" as const, title: MUP.title, paperId: MUP.paperId } };
const question = { start: { kind: "question" as const }, index: { pages: 41, documents: 12, projects: 3, chats: 9 } };

export const traceGoldenCases: TraceGoldenCase[] = [
  { name: "designed", content: traceAnswer, trace: traceFixture },
  { name: "worked-only", content: "Found it.", trace: traceWorkedOnly },
  { name: "running", content: "", trace: traceRunning, liveFor: 8000 },
  {
    name: "thinking-only", content: "It follows from the definition.",
    trace: [{ offset: 0, startedAt: 0, endedAt: 3000, entries: [
      { kind: "thought", at: 1000, text: "**Checking the definition**\n\nThe exponent is fixed by the width scaling." },
      { kind: "thought", at: 2500, text: "Answering from the definition" },
    ] }],
  },
  {
    name: "memory-chat", content: "The page already covers it.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 5000,
      context: { start: { kind: "page", title: KERNEL.title, slug: KERNEL.slug, pageKind: "concept" }, index: { pages: 97, documents: 26, projects: 7, chats: 22 } },
      entries: [
        { kind: "thought", at: 1200, text: "Opening the page the reader is on" },
        { kind: "tool", at: 2000, ms: 18, ok: true, tool: "open_memory", args: {}, results: [KERNEL] },
      ],
    }],
  },
  {
    name: "s1-read-webpage", content: "The article says so in its method section.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 4000,
      context: { start: { kind: "document", title: ARTICLE.title, paperId: ARTICLE.paperId } },
      entries: [{ kind: "tool", at: 1500, ms: 40, ok: true, tool: "read_webpage", args: { paperId: ARTICLE.paperId, anchor: "method" }, results: [ARTICLE] }],
    }],
  },
  {
    name: "s2-search-then-read", content: "The other paper reports it on page 4.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 6000, context: document,
      entries: [
        { kind: "thought", at: 800, text: "The open paper does not say; looking in the project" },
        { kind: "tool", at: 1500, ms: 35, ok: true, tool: "search_library", args: { query: "kernel stays constant during training" }, results: [NTK] },
        { kind: "tool", at: 3000, ms: 210, ok: true, tool: "read_paper", args: { paperId: NTK.paperId, pages: [3, 4] }, results: [NTK] },
      ],
    }],
  },
  {
    name: "s3-open-links-open", content: "Two pages bear on it.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 7000, context: question,
      entries: [
        { kind: "tool", at: 1000, ms: 12, ok: true, tool: "open_memory", args: {}, results: [ABC] },
        { kind: "tool", at: 2500, ms: 8, ok: true, tool: "memory_links", args: { slug: ABC.slug, hops: 2 }, results: [KERNEL, FEATURE, DOMAIN], found: 14 },
        { kind: "tool", at: 4000, ms: 15, ok: true, tool: "open_memory", args: {}, results: [KERNEL, FEATURE] },
      ],
    }],
  },
  {
    name: "s4-grep-open-read", content: "The exponent is 1/2, on page 6.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 9000, context: question,
      entries: [
        { kind: "tool", at: 1000, ms: 20, ok: true, tool: "grep_memory", args: { pattern: "learning rate.*width", within: "**/concept/*" }, results: [ABC, WIDTH] },
        { kind: "tool", at: 3000, ms: 14, ok: true, tool: "open_memory", args: {}, results: [ABC] },
        { kind: "tool", at: 5000, ms: 180, ok: true, tool: "read_paper", args: { paperId: MUP.paperId, pages: [6] }, results: [MUP] },
      ],
    }],
  },
  {
    name: "s5-open-then-figure", content: "The figure shows the optimum shifting with width.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 6000, context: question,
      entries: [
        { kind: "tool", at: 1000, ms: 16, ok: true, tool: "open_memory", args: {}, results: [FEATURE] },
        { kind: "tool", at: 2500, ms: 90, ok: true, tool: "view_figure", args: { figureId: "fig-3a1b" }, results: [] },
      ],
    }],
  },
  {
    name: "s6-read-then-web", content: "Later work extends it to depth.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 14000, context: document,
      entries: [
        { kind: "tool", at: 1000, ms: 200, ok: true, tool: "read_paper", args: { paperId: NTK.paperId, pages: [2] }, results: [NTK] },
        { kind: "thought", at: 3000, text: "The paper stops at width; searching for depth" },
        { kind: "tool", at: 4000, ms: 2100, ok: true, tool: "web_search", args: { query: "mu parametrization depth transfer" }, results: consulted(ARXIV, "https://github.com/microsoft/mup") },
        { kind: "tool", at: 8000, ms: 1900, ok: true, tool: "web_search", args: { query: "Tensor Programs VI depth" }, results: consulted("https://arxiv.org/abs/2310.02244") },
      ],
    }],
  },
  {
    name: "s7-descend-the-ladder", content: "Memory is thin here; the paper and one outside source settle it.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 16000, context: question,
      entries: [
        { kind: "tool", at: 1000, ms: 14, ok: true, tool: "open_memory", args: {}, results: [WIDTH] },
        { kind: "tool", at: 2500, ms: 30, ok: true, tool: "search_library", args: { query: "standard parametrization width" }, results: [MUP, NTK] },
        { kind: "tool", at: 4500, ms: 220, ok: true, tool: "read_paper", args: { paperId: MUP.paperId, pages: [2, 3] }, results: [MUP] },
        { kind: "tool", at: 8000, ms: 2400, ok: true, tool: "web_search", args: { query: "standard parametrization fails wide networks" }, results: consulted(ARXIV) },
      ],
    }],
  },
  {
    name: "s8-parallel-calls", content: "Both lookups agree.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 4000, context: question,
      entries: [
        { kind: "tool", at: 1000, ms: 15, ok: true, tool: "open_memory", args: {}, results: [ABC] },
        { kind: "tool", at: 1000, ms: 22, ok: true, tool: "grep_memory", args: { pattern: "maximal update" }, results: [ABC, FEATURE] },
      ],
    }],
  },
  {
    name: "s9-budgets-run-out", content: "This is what could be checked before the limits were reached.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 20000, context: document,
      entries: [
        { kind: "tool", at: 1000, ms: 190, ok: true, tool: "read_paper", args: { paperId: NTK.paperId, pages: [1] }, results: [NTK] },
        { kind: "tool", at: 3000, ms: 2, ok: false, error: "Limit reached", tool: "read_paper", args: { paperId: NTK.paperId, pages: [2] }, results: [] },
        { kind: "tool", at: 5000, ms: 1, ok: false, error: "Limit reached", tool: "open_memory", args: {}, results: [] },
        { kind: "tool", at: 7000, ms: 2000, ok: true, tool: "web_search", args: { query: "neural tangent kernel follow-up" }, results: consulted("https://arxiv.org/abs/1806.07572") },
        // Past the turn's allowance: the provider reports the call, and that it never ran.
        { kind: "tool", at: 9500, ms: 300, ok: false, error: "Limit reached", tool: "web_search", args: { query: "one search too many" }, results: [] },
        { kind: "thought", at: 15000, text: "Answering with what was read" },
      ],
    }],
  },
  {
    name: "s10-a-tool-fails", content: "The section exists under another name.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 12000, context: { start: { kind: "document", title: ARTICLE.title, paperId: ARTICLE.paperId } },
      entries: [
        { kind: "tool", at: 1000, ms: 6, ok: false, error: "Failed", tool: "read_webpage", args: { paperId: ARTICLE.paperId, anchor: "methods" }, results: [] },
        { kind: "tool", at: 2500, ms: 30, ok: true, tool: "read_webpage", args: { paperId: ARTICLE.paperId, anchor: "method" }, results: [ARTICLE] },
        { kind: "tool", at: 4000, ms: 5, ok: false, error: "Not found", tool: "open_memory", args: {}, results: [] },
        { kind: "tool", at: 5500, ms: 1, ok: false, error: "Failed", tool: "grep_memory", args: {}, results: [] },
        { kind: "tool", at: 7000, ms: 3, ok: false, error: "Failed", tool: "search_library", args: { query: "scaling exponent" }, results: [] },
        { kind: "tool", at: 9000, ms: 0, ok: false, error: "Interrupted", tool: "read_paper", args: { paperId: MUP.paperId, pages: [9] }, results: [] },
      ],
    }],
  },
  {
    name: "s11-image-question", content: "The plot matches Figure 2 of the paper.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 5000, context: document,
      entries: [{ kind: "tool", at: 1500, ms: 205, ok: true, tool: "read_paper", args: { paperId: NTK.paperId, pages: [5] }, results: [NTK] }],
    }],
  },
  {
    name: "s12-follow-up-turn", content: "Yes — the same table, one row down.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 3000, context: document,
      entries: [
        { kind: "thought", at: 700, text: "The earlier answer named the table" },
        { kind: "tool", at: 1200, ms: 190, ok: true, tool: "read_paper", args: { paperId: NTK.paperId, pages: [4] }, results: [NTK] },
      ],
    }],
  },
  {
    name: "s13-anchor-one-link-away", content: "It is the parametrization family you read about, with one exponent fixed.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 6000,
      context: { ...document, index: { pages: 41, documents: 12, projects: 3 }, given: [KERNEL, WIDTH] },
      entries: [
        { kind: "thought", at: 900, text: "The kernel page links to the parametrization family" },
        { kind: "tool", at: 1800, ms: 17, ok: true, tool: "open_memory", args: {}, results: [ABC] },
      ],
    }],
  },
  {
    // The three things a hosted web call can be, in the order a model does them.
    name: "web-search-open-find", content: "The abstract says so in its second sentence.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 12000, context: document,
      entries: [
        { kind: "tool", at: 1000, ms: 1800, ok: true, tool: "web_search", args: { query: "Tensor Programs V arXiv" }, results: consulted(ARXIV, "https://www.microsoft.com/en-us/research/publication/tuning-large-neural-networks/") },
        { kind: "tool", at: 4000, ms: 900, ok: true, tool: "web_search", args: { action: "open_page", url: `${ARXIV}?utm_source=openai` }, results: [] },
        { kind: "tool", at: 6000, ms: 400, ok: true, tool: "web_search", args: { action: "find_in_page", url: ARXIV, pattern: "maximal update" }, results: [] },
      ],
    }],
  },
  {
    name: "web-search-running", content: "", liveFor: 3000,
    trace: [{
      offset: 0, startedAt: 0, context: document,
      entries: [
        { kind: "tool", at: 1000, ms: 1500, ok: true, tool: "web_search", args: { query: "Tensor Programs V arXiv" }, results: consulted(ARXIV) },
        // Opened before the provider has said what it is: a search under way.
        { kind: "tool", at: 2800, tool: "web_search", args: {}, running: true },
      ],
    }],
  },
  {
    name: "memory-unavailable", content: "Answering from the paper alone.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 2000, context: { ...document, memory: "unavailable" },
      entries: [{ kind: "thought", at: 900, text: "Memory could not be read; the paper has it" }],
    }],
  },
  {
    name: "an-unknown-tool-and-a-long-record", content: "Done.",
    trace: [{
      offset: 0, startedAt: 0, endedAt: 2000, truncated: true,
      entries: [{ kind: "tool", at: 500, ms: 3, ok: true, tool: "a_tool_this_build_does_not_know", args: {}, results: [] }],
    }],
  },
];
