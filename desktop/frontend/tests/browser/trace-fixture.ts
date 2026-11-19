import type { AnswerTrace } from "../../app/lib/answer-trace.ts";

/** The answer in the design: two stretches of work around its first paragraph. */
export const traceAnswer =
  "The graph lookup lists the AI Infrastructure domain page as a direct neighbor but **does not traverse it**; these are the two-hop results excluding domain-page traversal.\n\n" +
  "Source: AI Infrastructure, its topic sections and “Pages in this domain” inventory.";

const SECOND = traceAnswer.indexOf("Source:");

export const traceFixture: AnswerTrace = [
  {
    offset: 0,
    startedAt: 0,
    endedAt: 9000,
    context: { start: { kind: "question" }, index: { pages: 97, documents: 26, projects: 7, chats: 22 } },
    entries: [
      { kind: "thought", at: 1000, text: "**Looking for Memory pages on speculative decoding**" },
      { kind: "tool", at: 2000, ms: 12, ok: true, tool: "grep_memory", args: { pattern: "speculative[ -]decod|draft[ -]models?" }, results: [] },
      { kind: "tool", at: 4000, ms: 6, ok: true, tool: "memory_links", args: { slug: "vllm-omni-2602-02204v1", hops: 2 }, results: [] },
      { kind: "thought", at: 5000, text: "The AI Infrastructure domain page is a neighbor; skip it, keep the two-hop pages" },
      {
        kind: "tool", at: 6000, ms: 20, ok: true, tool: "open_memory", args: {},
        results: [
          { slug: "scaling-up-test-time-compute-with-latent-reason-386a6008516d", title: "Scaling up Test-Time Compute with Latent Reasoning - A Recurrent Depth Approach (2502.05171v2)", kind: "source" },
          { slug: "scaling-up-test-time-compute-with-latent-reason-81a69220ce2b", title: "Scaling up Test-Time Compute with Latent Reasoning - A Recurrent Depth Approach (2502.05171v2)", kind: "source" },
        ],
      },
      { kind: "thought", at: 9000, text: "Answering with the two-hop results" },
    ],
  },
  {
    offset: SECOND,
    startedAt: 12000,
    endedAt: 16000,
    entries: [
      { kind: "thought", at: 12000, text: "Naming where the inventory came from" },
      { kind: "tool", at: 13000, ms: 9, ok: false, error: "Not found", tool: "memory_links", args: { slug: "speculative-decoding" }, results: [] },
      { kind: "tool", at: 14000, ms: 14, ok: true, tool: "grep_memory", args: { pattern: "draft[ -]models?" }, results: [{ slug: "reverse-kl-and-dense-token-feedback", title: "Reverse KL and dense token feedback", kind: "concept" }] },
    ],
  },
];

/** A stretch of calls the model said nothing about. */
export const traceWorkedOnly: AnswerTrace = [
  {
    offset: 0, startedAt: 0, endedAt: 2000,
    entries: [{ kind: "tool", at: 500, ms: 14, ok: true, tool: "grep_memory", args: { pattern: "draft" }, results: [{ slug: "reverse-kl", title: "Reverse KL", kind: "concept" }] }],
  },
];

/** The stretch still running: a call in progress at the end of it. */
export const traceRunning: AnswerTrace = [
  {
    offset: 0, startedAt: 0,
    context: {
      start: { kind: "document", title: "On-Policy Distillation", paperId: "a06f" },
      index: { pages: 97, documents: 26, projects: 7 },
      given: [{ slug: "reverse-kl", title: "Reverse KL and dense token feedback", kind: "concept" }],
    },
    entries: [
      { kind: "thought", at: 6000, text: "Looking for Memory pages on speculative decoding" },
      { kind: "tool", at: 7000, tool: "grep_memory", args: { pattern: "speculative[ -]decod" }, running: true },
    ],
  },
];
