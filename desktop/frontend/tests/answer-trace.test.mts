import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  activeCall,
  answerSegments,
  applyTraceEvent,
  cleanThought,
  contextRows,
  foldSummary,
  isAnswerTrace,
  liveWindow,
  resultTags,
  stretchPages,
  stretchRows,
  toolPhrase,
  TRACE_LIVE_VISIBLE,
  RETIRED_TRACE_TOOLS,
  TRACE_TOOLS,
  type AnswerTrace,
  type ToolEntry,
  type TraceEvent,
  type TraceStretch,
} from "../app/lib/answer-trace.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const tool = (fields: Partial<ToolEntry> & { tool: string }): ToolEntry => ({
  kind: "tool", at: 0, args: {}, ok: true, ms: 10, results: [], ...fields,
});
const stretch = (fields: Partial<TraceStretch>): TraceStretch => ({
  offset: 0, startedAt: 0, endedAt: 9000, entries: [], ...fields,
});

test("the stream builds exactly the record a reload is given", () => {
  // The backend sends each change as it happens and stores the result. A
  // client that applies the events holds that result, so there is no second
  // account of an answer to drift from the first.
  const events: TraceEvent[] = [
    { type: "trace", stretch: 0, open: { offset: 0, startedAt: 0, context: { start: { kind: "question" } } } },
    { type: "trace", stretch: 0, entry: 0, set: { kind: "thought", at: 1000, text: "" } },
    { type: "trace", stretch: 0, entry: 0, text: "Looking for " },
    { type: "trace", stretch: 0, entry: 0, text: "Memory pages" },
    { type: "trace", stretch: 0, entry: 1, set: { kind: "tool", at: 2000, tool: "grep_memory", args: { pattern: "draft" }, running: true } },
    { type: "trace", stretch: 0, entry: 1, set: tool({ at: 2000, tool: "grep_memory", args: { pattern: "draft" }, ms: 40 }) },
    { type: "trace", stretch: 0, close: { endedAt: 3000 } },
    { type: "trace", stretch: 1, open: { offset: 42, startedAt: 5000 } },
    { type: "trace", stretch: 1, entry: 0, set: { kind: "thought", at: 5000, text: "Checking" } },
  ];
  const steps: AnswerTrace[] = [];
  const trace = events.reduce<AnswerTrace>((current, event) => {
    const next = applyTraceEvent(current, event);
    steps.push(next);
    return next;
  }, []);
  assert.deepEqual(trace, [
    {
      offset: 0, startedAt: 0, endedAt: 3000, context: { start: { kind: "question" } },
      entries: [
        { kind: "thought", at: 1000, text: "Looking for Memory pages" },
        tool({ at: 2000, tool: "grep_memory", args: { pattern: "draft" }, ms: 40 }),
      ],
    },
    { offset: 42, startedAt: 5000, entries: [{ kind: "thought", at: 5000, text: "Checking" }] },
  ]);
  // A call is one entry from start to finish: running, then completed in place.
  assert.equal((steps[4][0].entries[1] as ToolEntry).running, true);
  assert.equal(steps[5][0].entries.length, 2);
  // Each step is a new value; nothing a rendered row holds is changed under it.
  assert.notEqual(steps[2], steps[3]);
  assert.equal(steps[2][0].entries[0].kind === "thought" && steps[2][0].entries[0].text, "Looking for ");
  // Nothing that is not this shape is drawn — an answer stored before it, say.
  assert.ok(isAnswerTrace(trace));
  assert.ok(!isAnswerTrace({ turns: 1, calls: [] }));
  assert.ok(!isAnswerTrace(undefined));
});

test("a fold says how long, how much, and whether pages came of it", () => {
  const thought = { kind: "thought" as const, at: 1000, text: "**Looking**\n\nfor pages" };
  const opened = tool({
    tool: "open_memory",
    results: [
      { slug: "a-386a6008516d", title: "Latent Reasoning", kind: "source" },
      { slug: "a-81a69220ce2b", title: "Latent Reasoning", kind: "source" },
    ],
  });
  const lookup = tool({ tool: "grep_memory", args: { pattern: "x" }, results: [{ slug: "kl", title: "Reverse KL", kind: "concept" }] });
  assert.equal(foldSummary(stretch({ entries: [thought, lookup, opened] })), "Thought for 0:09 · 3 steps · 3 pages");
  // "Worked for" when the model sent no thoughts; lookups are called lookups.
  assert.equal(foldSummary(stretch({ endedAt: 2000, entries: [lookup] })), "Worked for 0:02 · 1 lookup · 1 page");
  assert.equal(foldSummary(stretch({ endedAt: 2000, entries: [lookup, opened] })), "Worked for 0:02 · 2 steps · 3 pages");
  assert.equal(foldSummary(stretch({ endedAt: 3000, entries: [thought, { ...thought, at: 2000 }] })), "Thought for 0:03 · 2 steps");
  // Context is what the answer was handed, never a step; a blank thought is not one either.
  const handed = stretch({ endedAt: 1000, context: { start: { kind: "question" } }, entries: [{ kind: "thought", at: 0, text: "  " }] });
  assert.equal(stretchRows(handed).length, 0);
  assert.equal(foldSummary(handed), "Worked for 0:01");
  // A page returned twice is one page.
  assert.equal(stretchPages(stretch({ entries: [lookup, lookup] })), 1);
});

test("a call is said as what was done, never as the tool's name", () => {
  assert.deepEqual(toolPhrase(tool({ tool: "grep_memory", args: { pattern: "draft[ -]models?" } })), {
    verb: "Searched page text", joiner: "for", code: "draft[ -]models?", quote: undefined, results: [],
  });
  // The present tense while it runs.
  assert.equal(toolPhrase(tool({ tool: "grep_memory", args: { pattern: "x" }, running: true })).verb, "Searching page text");
  assert.equal(toolPhrase(tool({ tool: "memory_links", args: { slug: "vllm-omni" } })).joiner, "from");
  // A question is quoted; a pattern or a slug is code.
  assert.equal(toolPhrase(tool({ tool: "search_library", args: { query: "teacher quality" } })).quote, "teacher quality");
  // Counted tools lead with how many, and nest the pages beneath.
  const opened = toolPhrase(tool({ tool: "open_memory", results: [{ slug: "a", title: "A", kind: "concept" }, { slug: "b", title: "B", kind: "concept" }] }));
  assert.equal(`${opened.verb} ${opened.plain}`, "Opened 2 pages");
  assert.equal(opened.results.length, 2);
  // A read names its document and where in it, and does not repeat it below.
  const read = toolPhrase(tool({ tool: "read_paper", args: { paperId: "p", pages: [3, 4] }, results: [{ paperId: "p", title: "SGLang", kind: "pdf" }] }));
  assert.deepEqual([read.verb, read.plain, read.results.length], ["Read", "pp. 3, 4 of SGLang", 0]);
  assert.equal(toolPhrase(tool({ tool: "read_webpage", args: { anchor: "intro" }, results: [{ paperId: "w", title: "Post", kind: "web-page" }] })).plain, "§intro of Post");
  assert.equal(toolPhrase(tool({ tool: "read_webpage", args: { anchor: "all" }, results: [{ paperId: "w", title: "Post", kind: "web-page" }] })).plain, "all of Post");
  // A tool this table does not know is still a row, and still not its raw name.
  assert.equal(toolPhrase(tool({ tool: "run_python" })).verb, "Ran a step");
  for (const [id, spec] of Object.entries(TRACE_TOOLS)) {
    assert.ok(spec.done && spec.running && !spec.done.includes("_"), `${id} has no wording`);
  }
});

test("a call is shown from the moment the model begins writing it", () => {
  // A draft's whole source is its argument, so writing it is a step of its own.
  assert.equal(toolPhrase(tool({ tool: "render_artifact", args: {}, running: true, writing: true })).verb, "Writing a draft");
  const written = toolPhrase(tool({ tool: "render_artifact", args: { title: "IsoFLOP curves" }, running: true }));
  assert.deepEqual([written.verb, written.quote], ["Rendering a draft", "IsoFLOP curves"]);
  // A tool whose arguments are short reads as running from the start.
  assert.equal(toolPhrase(tool({ tool: "search_library", args: {}, running: true, writing: true })).verb, "Searching documents");
  // A call cut off before it ran is never said as though it ran.
  assert.equal(toolPhrase(tool({ tool: "render_artifact", ok: false, error: "Interrupted", writing: true })).verb, "Writing a draft");
  assert.equal(toolPhrase(tool({ tool: "render_artifact", ok: false, error: "Interrupted", queued: true })).verb, "Rendering a draft");
});

test("the spinner sits on the call being written or run, not on one waiting its turn", () => {
  const first = tool({ tool: "search_library", running: true, ok: undefined });
  const waiting = tool({ tool: "render_artifact", running: true, queued: true, ok: undefined });
  assert.equal(activeCall(stretch({ endedAt: undefined, entries: [first, waiting] })), first);
  const writing = tool({ tool: "render_artifact", running: true, writing: true, ok: undefined });
  assert.equal(activeCall(stretch({ endedAt: undefined, entries: [{ ...first, queued: true }, writing] })), writing);
  assert.equal(activeCall(stretch({ entries: [tool({ tool: "search_library" })] })), undefined);
});

test("a call asked for before the answer resumed is drawn running where it was asked, and counted in its fold", () => {
  const content = "Before. After.";
  const asked = stretch({ offset: 8, endedAt: 2000, entries: [tool({ tool: "render_artifact", at: 1000, running: true, ok: undefined })] });
  const [, work] = answerSegments(content, [asked]);
  assert.equal(work.kind === "work" && work.open, true);
  const waiting = { ...asked, entries: [{ ...asked.entries[0], queued: true }] };
  assert.equal(answerSegments(content, [waiting]).some((segment) => segment.kind === "work" && segment.open), false);
  // Its run outlasted the stretch: the fold says how long the work took.
  const finished = { ...asked, entries: [tool({ tool: "render_artifact", at: 1000, ms: 9000 })] };
  assert.match(foldSummary(finished), /^Worked for 0:10/);
});

test("two results with one title are told apart by their ids, and only they", () => {
  assert.deepEqual(resultTags([
    { slug: "scaling-up-386a6008516d", title: "Scaling up", kind: "source" },
    { slug: "kv-cache", title: "KV cache", kind: "concept" },
    { slug: "scaling-up-81a69220ce2b", title: "Scaling up", kind: "source" },
  ]), ["386a", "", "81a6"]);
});

test("context says what the answer was handed", () => {
  assert.deepEqual(contextRows({ start: { kind: "question" }, index: { pages: 97, documents: 26, projects: 7, chats: 22 } }), [
    { glyph: "question", label: "Your question", detail: "nothing open beside the chat" },
    { glyph: "index", label: "Index: 97 pages · 26 documents · 22 chats", detail: "" },
  ]);
  // Pages Delphi put in the request are context too: handed over, not a call.
  const given = [{ slug: "kl", title: "Reverse KL", kind: "concept" }];
  assert.deepEqual(contextRows({ start: { kind: "document", title: "On-Policy Distillation", paperId: "d" }, index: { pages: 1, documents: 6, projects: 2 }, given }), [
    { glyph: "document", label: "Open document", detail: "On-Policy Distillation" },
    { glyph: "index", label: "Index: 1 page · 6 documents", detail: "" },
    { glyph: "pages", label: "Given 1 page from your Memory", detail: "", results: given },
  ]);
  assert.equal(foldSummary(stretch({ endedAt: 1000, context: { start: { kind: "question" }, given } })), "Worked for 0:01");
  // A selection that could not be made is said, and is not "nothing chosen".
  assert.equal(contextRows({ start: { kind: "question" }, memory: "unavailable" })[1].detail, "could not be consulted before this answer");
  // Choosing is a call the reader waits on: said while it runs, then with when it ended.
  const open = { kind: "document" as const, title: "A paper", paperId: "d" };
  assert.deepEqual(contextRows({ start: open, memory: "choosing" }, true)[1], { glyph: "pages", label: "Choosing from your Memory", detail: "", running: true });
  assert.equal(contextRows({ start: open, memory: "choosing" }).length, 1, "an answer that is over is not still choosing");
  assert.deepEqual(contextRows({ start: open, given, memoryMs: 4200 })[1], { glyph: "pages", label: "Given 1 page from your Memory", detail: "", results: given, at: 4200 });
  assert.deepEqual(contextRows({ start: open, memory: "none", memoryMs: 3100 })[1], { glyph: "pages", label: "Nothing in Memory bears on this", detail: "", at: 3100 });
  assert.equal(contextRows({ start: open, memory: "unavailable", memoryMs: 20000 })[1].at, 20000);
  assert.deepEqual(contextRows(undefined), []);
});

test("an answer is text and work in the order they happened", () => {
  const content = "First part. Second part.";
  const worked = (offset: number): TraceStretch => stretch({ offset, entries: [{ kind: "thought", at: 0, text: "t" }] });
  assert.deepEqual(answerSegments(content, [worked(0), worked(12)]).map((segment) => segment.kind), ["work", "text", "work", "text"]);
  // An offset past the end is clamped: a stretch never splits what is not there.
  assert.deepEqual(answerSegments("Hi", [worked(50)]).map((segment) => segment.kind), ["text", "work"]);
  // A stretch never cuts a code block in two.
  const fenced = "Before\n```\ncode\n```\nAfter";
  const split = answerSegments(fenced, [worked(12)]);
  assert.equal(split[0].kind === "text" && split[0].text, "Before\n```\ncode\n```\n");
  // A stretch with nothing to show is not drawn; one that only carries context is.
  assert.deepEqual(answerSegments("Hi", [stretch({ entries: [] })]).map((segment) => segment.kind), ["text"]);
  assert.deepEqual(answerSegments("Hi", [stretch({ context: { start: { kind: "question" } } })]).map((segment) => segment.kind), ["work", "text"]);
  assert.deepEqual(answerSegments("Hi", []).map((segment) => segment.kind), ["text"]);
});

test("a thought is shown as prose, its heading kept apart from its paragraph", () => {
  // A bold heading on its own line ends in a full stop, so it does not run
  // into the sentence after it.
  assert.equal(cleanThought("**Resolving the document**\n\nThe last one attached is X."), "Resolving the document. The last one attached is X.");
  // A heading that already ends in punctuation keeps it.
  assert.equal(cleanThought("**Which one?**\nThe last one."), "Which one? The last one.");
  // A heading alone, or bold inside a sentence, is just text.
  assert.equal(cleanThought("**Clarifying targets**"), "Clarifying targets");
  assert.equal(cleanThought("Use **pp. 4** here"), "Use pp. 4 here");
});

test("a running stretch keeps its last few rows and counts the rest", () => {
  assert.deepEqual(liveWindow([1, 2], 3), { earlier: 0, shown: [1, 2] });
  assert.deepEqual(liveWindow([1, 2, 3, 4, 5, 6], 3), { earlier: 3, shown: [4, 5, 6] });
  assert.equal(TRACE_LIVE_VISIBLE, 3);
});

test("the trace animates transforms and opacity only", async () => {
  const css = await read("../app/globals.css");
  const frames = [...css.matchAll(/@keyframes (trace-[\w-]+) \{([\s\S]*?)\n\}/g)];
  assert.ok(frames.length >= 3);
  for (const [, name, body] of frames) {
    const properties = [...body.matchAll(/([a-z-]+):/g)].map((match) => match[1]);
    assert.ok(properties.every((property) => property === "transform" || property === "opacity"), `${name} animates ${properties.join(", ")}`);
  }
});

test("there is one account of how an answer was reached", async () => {
  const [panel, bits] = await Promise.all([read("../app/components/ChatPanel.tsx"), read("../app/components/ChatBits.tsx")]);
  // The two panels this replaced are gone, and nothing is held by the tab alone.
  for (const source of [panel, bits]) {
    assert.doesNotMatch(source, /How it got there|How this was worked out|liveTrace|message\.walk/);
  }
  // Live and reloaded answers are drawn from the same record.
  assert.match(panel, /applyTraceEvent\(current\.stretches/);
  assert.match(panel, /isAnswerTrace\(message\.trace\)/);
});

test("a hosted web call is said as what it was: a search, a page opened, or a find within one", () => {
  const arxiv = "https://arxiv.org/abs/2203.03466";
  const consulted = [{ url: arxiv, title: "arxiv.org", kind: "web" }];
  // A search is the tool's own row, with where it looked nested under it.
  assert.deepEqual(toolPhrase(tool({ tool: "web_search", args: { query: "mu parametrization" }, results: consulted })), {
    verb: "Searched the web", joiner: "for", code: undefined, quote: "mu parametrization", results: consulted,
  });
  assert.deepEqual(toolPhrase(tool({ tool: "web_search", args: { action: "open_page", url: `${arxiv}?utm_source=openai` } })), {
    verb: "Opened", link: { href: `${arxiv}?utm_source=openai`, text: "arxiv.org/abs/2203.03466" }, results: [],
  });
  assert.deepEqual(toolPhrase(tool({ tool: "web_search", args: { action: "find_in_page", url: arxiv, pattern: "maximal update" } })), {
    verb: "Searched", code: "arxiv.org", then: { joiner: "for", code: "maximal update" }, results: [],
  });
  assert.equal(toolPhrase(tool({ tool: "web_search", args: { action: "open_page", url: arxiv }, running: true })).verb, "Opening");
  // Before the provider has said what the call is, it is a search under way.
  assert.equal(toolPhrase(tool({ tool: "web_search", args: {}, running: true })).verb, "Searching the web");
  // An action with nowhere safe to point falls back to the plain row.
  assert.equal(toolPhrase(tool({ tool: "web_search", args: { action: "open_page", url: "javascript:alert(1)" } })).verb, "Searched the web");
});

test("every tool a chat profile offers has a row here, and there is no row for anything else", async () => {
  const { readFile } = await import("node:fs/promises");
  const catalogue = JSON.parse(await readFile(new URL("./fixtures/tool-catalogue.json", import.meta.url), "utf8"));
  // The same file is asserted against the tools the backend's chat profiles
  // offer by its structure test, so a chat tool renamed or added there fails
  // here until its row exists. A tool only a maintenance run is offered is in
  // no answer's trace, and has no row.
  // A retired tool keeps its row for the saved answers that called it.
  assert.deepEqual(Object.keys(TRACE_TOOLS).filter(name => !RETIRED_TRACE_TOOLS.has(name)).sort(), catalogue);
});
