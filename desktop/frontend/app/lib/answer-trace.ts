/**
 * How an answer was reached, as one record: what it was handed, what the model
 * said it was doing, and every call Delphi ran for it, in the order they
 * happened.
 *
 * The backend builds this record once and uses it twice. While an answer is
 * written it sends each change as a `trace` event, and `applyTraceEvent`
 * reduces those into an `AnswerTrace`; when the answer is done the same record
 * is stored on the message and comes back on a reload. So the fold a reader
 * watches being built and the one they open a month later are drawn from the
 * same data by the same code, and nothing here derives a second account that
 * could drift from the first.
 *
 * Two kinds of entry, and the difference is the backend's to keep: a **tool**
 * entry is Delphi's own record of a call it ran, exact; a **thought** entry is
 * the model's summary of its reasoning, kept beside the calls it explains.
 *
 * A record is a list of **stretches** — the work between two pieces of answer
 * text — each anchored where it happened in the answer. An `offset` counts
 * UTF-16 code units, which is how a string is sliced here; every time is
 * milliseconds since the request began, never a clock time.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

import { formatClock } from "./clock.ts";
import { isWebUrl, pageName, siteName } from "./web-sources.ts";
import { markdownCodeRanges } from "./markdown-pipeline.ts";

export { formatClock };

/** A page or document a call returned. One of `slug`, `paperId` and `url` names it:
 *  a Memory page, a document in the library, or a page on the web. */
export type TraceResult = { slug?: string; paperId?: string; url?: string; title: string; kind: string };

export type ThoughtEntry = { kind: "thought"; at: number; text: string };

export type ToolEntry = {
  kind: "tool";
  at: number;
  /** The tool's id. `TRACE_TOOLS` turns it into a glyph and a verb. */
  tool: string;
  /** Only what a row shows: a pattern, a question, a slug, pages. */
  args: Record<string, unknown>;
  /** Set from when the model begins the call until Delphi has answered it. */
  running?: boolean;
  /** The model is still writing the call's arguments; nothing has run yet. */
  writing?: boolean;
  /** Written, and waiting for Delphi to run it after the calls before it. */
  queued?: boolean;
  ms?: number;
  ok?: boolean;
  /** Two words on why a call did not do what was asked. */
  error?: string;
  results?: TraceResult[];
  /** How many a lookup matched, when more than `results` lists. */
  found?: number;
};

export type TraceEntry = ThoughtEntry | ToolEntry;

/** What the answer was handed before it did anything. First stretch only. */
export type TraceContext = {
  start: {
    kind: "question" | "page" | "document" | "project";
    title?: string;
    slug?: string;
    pageKind?: string;
    paperId?: string;
  };
  /** How much there was to choose from, when the whole index was read. */
  index?: { pages?: number; documents?: number; projects?: number; chats?: number };
  /** Memory pages Delphi chose and put in the request before the answer. */
  given?: TraceResult[];
  /**
   * What choosing those pages came to when it gave none: still under way,
   * a considered nothing, or Memory could not be consulted, which is not
   * "nothing chosen".
   */
  memory?: "choosing" | "none" | "unavailable";
  /** When the choosing ended, from the request, in milliseconds. */
  memoryMs?: number;
};

export type TraceStretch = {
  /** Answer characters already written when the stretch began. */
  offset: number;
  startedAt: number;
  /** When answer text resumed, or the answer finished. Unset while it runs. */
  endedAt?: number;
  context?: TraceContext;
  /** The record stopped growing here; there was more than it keeps. */
  truncated?: boolean;
  entries: TraceEntry[];
};

export type AnswerTrace = TraceStretch[];

/** A record this code can draw. Anything else on a message is not one. */
export function isAnswerTrace(value: unknown): value is AnswerTrace {
  return Array.isArray(value) && value.every((stretch) => stretch && Array.isArray(stretch.entries));
}

/** One change to the record, as the stream sends it. */
export type TraceEvent = {
  type: "trace";
  stretch: number;
  open?: Partial<TraceStretch>;
  close?: { endedAt: number };
  entry?: number;
  set?: TraceEntry;
  text?: string;
};

/**
 * The record after one more event. Pure, and total: an event that names a
 * stretch or an entry that does not exist yet creates it, so a client that
 * missed nothing and one that reconnected end with the same thing.
 */
export function applyTraceEvent(trace: AnswerTrace, event: TraceEvent): AnswerTrace {
  if (!Number.isInteger(event.stretch) || event.stretch < 0) return trace;
  const next = trace.slice();
  while (next.length <= event.stretch) next.push({ offset: 0, startedAt: 0, entries: [] });
  const stretch = { ...next[event.stretch] };
  if (event.open) Object.assign(stretch, event.open);
  if (event.close) stretch.endedAt = event.close.endedAt;
  if (typeof event.entry === "number" && event.entry >= 0) {
    const entries = stretch.entries.slice();
    if (event.set) {
      entries[event.entry] = event.set;
    } else if (typeof event.text === "string") {
      const current = entries[event.entry];
      if (current?.kind === "thought") entries[event.entry] = { ...current, text: current.text + event.text };
    }
    // An index past the end leaves no hole to draw.
    stretch.entries = Array.from(entries, (entry) => entry ?? { kind: "thought", at: 0, text: "" });
  }
  next[event.stretch] = stretch;
  return next;
}

/** The stretch still being worked on, if the answer has not resumed since. */
export function openStretch(trace: AnswerTrace): TraceStretch | undefined {
  const last = trace[trace.length - 1];
  return last && last.endedAt === undefined ? last : undefined;
}

/**
 * The call being worked on now: the one the model is writing, or the one
 * Delphi is running. Calls written and waiting their turn (`queued`) are not
 * it, so with several calls the spinner sits on the one that is moving.
 */
export function activeCall(stretch: TraceStretch): ToolEntry | undefined {
  return stretch.entries.findLast((entry): entry is ToolEntry => entry.kind === "tool" && Boolean(entry.running) && !entry.queued);
}

export type AnswerSegment =
  | { kind: "text"; text: string; key: string }
  | { kind: "work"; stretch: TraceStretch; index: number; open: boolean; key: string };

/**
 * The answer in the order it happened: text up to each stretch's offset, the
 * stretch, then the text after it. Offsets are clamped to the text, so a
 * stretch can never split what is not there; a stretch with nothing to show
 * is left out.
 */
export function answerSegments(content: string, trace: AnswerTrace): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  // Use Markdown's actual code nodes: a longer fence may contain shorter
  // ones, and a quoted artifact is still one indivisible document.
  const dividesText = trace.some(stretch => stretch.offset > 0 && stretch.offset < content.length && (stretch.context || stretchRows(stretch).length));
  const code = dividesText ? markdownCodeRanges(content) : [];
  let from = 0;
  trace.forEach((stretch, index) => {
    if (!stretchRows(stretch).length && !stretch.context) return;
    let at = Math.min(Math.max(stretch.offset, from), content.length);
    const containing = code.find(([start, end]) => start < at && at < end);
    if (containing) {
      at = containing[1];
      if (content[at] === "\n") at++;
    }
    const text = content.slice(from, at);
    if (text.trim()) segments.push({ kind: "text", text, key: `text-${from}` });
    // A call asked for before the answer resumed still runs where it was asked.
    const open = stretch.endedAt === undefined || activeCall(stretch) !== undefined;
    segments.push({ kind: "work", stretch, index, open, key: `work-${index}` });
    from = at;
  });
  const rest = content.slice(from);
  if (rest.trim()) segments.push({ kind: "text", text: rest, key: `text-${from}` });
  return segments;
}

/**
 * Reasoning summaries arrive as light markdown; a row wants prose. A summary
 * often opens with a bold heading on its own line ("**Clarifying targets**")
 * and then its paragraph. Joined with a bare space the two would run together
 * as one sentence, so a heading that does not end in punctuation is given a
 * full stop first.
 */
export function cleanThought(text: string): string {
  const heading = /^\s*\*\*([^*\n]+)\*\*\s*\n+([\s\S]*\S[\s\S]*)$/.exec(text);
  const joined = heading
    ? `${heading[1].trim()}${/[.!?:…]$/.test(heading[1].trim()) ? "" : "."} ${heading[2]}`
    : text;
  return joined
    .replace(/\*\*/g, "")
    .replace(/^[#\s*-]+/, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** The entries a stretch shows: every call, and every thought that says something. */
export function stretchRows(stretch: TraceStretch): TraceEntry[] {
  return stretch.entries.filter((entry) => entry.kind === "tool" || cleanThought(entry.text));
}

/** Which glyph a row is marked with. Drawn by `TraceGlyph`. */
export type TraceGlyph =
  | "question" | "index" | "search" | "links" | "page" | "pages" | "document"
  | "figure" | "web" | "tool";

/**
 * How a tool is said, by id. The row never shows the raw tool name: it shows
 * what was done, in the past tense once it is done and the present while it
 * runs, then the one argument the call was pointed at.
 *
 * `argument` names which `args` field that is and how it reads: a pattern or
 * a slug is code, a question is quoted. A tool with `counts` leads with how
 * many it returned ("Opened 2 pages") instead of an argument.
 *
 * `writing` is said while the model is still writing the call, for a tool
 * whose arguments take long enough to watch: a draft's whole source is one.
 * Any other tool reads as running from the moment the call begins.
 *
 * A new tool adds a line here and nothing else changes. The keys are the
 * backend catalogue's tool names, and a test holds the two lists equal: a tool
 * renamed or added there cannot ship without its row here.
 */
export type TraceTool = {
  glyph: TraceGlyph;
  done: string;
  running: string;
  writing?: string;
  argument?: { field: string; joiner: string; as: "code" | "quote" };
  /** The noun its results are counted in, singular. */
  counts?: string;
  /** A lookup finds pages; it does not open them. Used by the fold's summary. */
  lookup?: boolean;
};

export const TRACE_TOOLS: Record<string, TraceTool> = {
  open_memory: { glyph: "page", done: "Opened", running: "Opening", counts: "page" },
  grep_memory: {
    glyph: "search", done: "Searched page text", running: "Searching page text",
    argument: { field: "pattern", joiner: "for", as: "code" }, lookup: true,
  },
  memory_links: {
    glyph: "links", done: "Followed links", running: "Following links",
    argument: { field: "slug", joiner: "from", as: "code" }, lookup: true,
  },
  search_library: {
    glyph: "search", done: "Searched documents", running: "Searching documents",
    argument: { field: "query", joiner: "for", as: "quote" }, lookup: true,
  },
  read_paper: { glyph: "document", done: "Read", running: "Reading" },
  read_webpage: { glyph: "document", done: "Read", running: "Reading" },
  read_url: { glyph: "web", done: "Read a source", running: "Reading a source" },
  view_figure: { glyph: "figure", done: "Looked at a figure", running: "Looking at a figure" },
  render_artifact: {
    glyph: "figure", done: "Rendered a draft", running: "Rendering a draft", writing: "Writing a draft",
    argument: { field: "title", joiner: "of", as: "quote" },
  },
  draw_display: { glyph: "figure", done: "Drew a draft", running: "Drawing a draft", writing: "Writing a draft" },
  embed_figure: {
    glyph: "figure", done: "Placed a figure", running: "Placing a figure",
    argument: { field: "title", joiner: "of", as: "quote" },
  },
  publish_artifact: {
    glyph: "figure", done: "Published a visualization", running: "Publishing a visualization",
  },
  web_search: {
    glyph: "web", done: "Searched the web", running: "Searching the web",
    argument: { field: "query", joiner: "for", as: "quote" }, lookup: true,
  },
};

/** Tools no chat offers any more whose rows saved answers still show. */
export const RETIRED_TRACE_TOOLS = new Set(["render_artifact"]);

const UNKNOWN_TOOL: TraceTool = { glyph: "tool", done: "Ran a step", running: "Running a step" };

export function traceTool(entry: ToolEntry): TraceTool {
  return TRACE_TOOLS[entry.tool] ?? UNKNOWN_TOOL;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Where in a document a read looked: its pages, or its section. */
function readLocator(args: Record<string, unknown>): string {
  const pages = Array.isArray(args.pages) ? args.pages.filter((page) => typeof page === "number") : [];
  if (pages.length) return `${pages.length === 1 ? "p." : "pp."} ${pages.join(", ")}`;
  if (typeof args.anchor !== "string" || !args.anchor) return "";
  // The whole page is not a section of it.
  return args.anchor === "all" ? "all" : `§${args.anchor}`;
}

/**
 * A call as a row says it: the verb, then what it was pointed at.
 *
 * `plain` is ordinary text after the verb; `code` and `quote` are the argument
 * in the form the tool table asks for. A read names its document and where in
 * it, so the document is not repeated as a result row beneath.
 */
export type ToolPhrase = {
  verb: string;
  joiner?: string;
  code?: string;
  quote?: string;
  plain?: string;
  /** A page on the web the call was pointed at, said as its site and path. */
  link?: { href: string; text: string };
  /** A second thing the call was given: what was looked for on that site. */
  then?: { joiner: string; code: string };
  /** Result rows to nest under the call. */
  results: TraceResult[];
};

/**
 * A hosted web call, which is one of three things. The provider runs it and
 * says which: a search, a page it opened, or a find within a page. A search is
 * the unmarked case and reads as the tool's own row.
 */
function webPhrase(entry: ToolEntry, results: TraceResult[]): ToolPhrase | null {
  const url = isWebUrl(entry.args.url) ? entry.args.url : undefined;
  if (entry.args.action === "open_page" && url) {
    return { verb: entry.running ? "Opening" : "Opened", link: { href: url, text: pageName(url) }, results };
  }
  if (entry.args.action === "find_in_page" && url) {
    const pattern = typeof entry.args.pattern === "string" ? entry.args.pattern : "";
    return {
      verb: entry.running ? "Searching" : "Searched", code: siteName(url),
      ...(pattern ? { then: { joiner: "for", code: pattern } } : {}), results,
    };
  }
  return null;
}

export function toolPhrase(entry: ToolEntry): ToolPhrase {
  const tool = traceTool(entry);
  // A call that never ran (still being written, waiting, or cut off before
  // its turn) is said in the present tense, never as though it ran.
  const verb = entry.writing ? tool.writing ?? tool.running : entry.running || entry.queued ? tool.running : tool.done;
  const results = entry.results ?? [];
  const web = entry.tool === "web_search" ? webPhrase(entry, results) : null;
  if (web) return web;
  if (entry.tool === "read_paper" || entry.tool === "read_webpage") {
    const locator = readLocator(entry.args);
    const title = results[0]?.title;
    return {
      verb,
      plain: [locator, title ? `${locator ? "of " : ""}${title}` : ""].filter(Boolean).join(" "),
      results: [],
    };
  }
  if (tool.counts) {
    const total = entry.found ?? results.length;
    return {
      verb,
      plain: entry.running ? undefined : plural(total, tool.counts),
      results,
    };
  }
  const value = tool.argument ? entry.args[tool.argument.field] : undefined;
  const argument = typeof value === "string" && value ? value : undefined;
  return {
    verb,
    joiner: argument ? tool.argument?.joiner || undefined : undefined,
    code: argument && tool.argument?.as === "code" ? argument : undefined,
    quote: argument && tool.argument?.as === "quote" ? argument : undefined,
    results,
  };
}

/**
 * What tells two results with one title apart: the first characters of the id
 * at the end of each slug. Empty for a result whose title is its own.
 */
export function resultTags(results: TraceResult[]): string[] {
  const seen = new Map<string, number>();
  for (const result of results) seen.set(result.title, (seen.get(result.title) ?? 0) + 1);
  return results.map((result) => {
    if ((seen.get(result.title) ?? 0) < 2) return "";
    const id = result.slug ?? result.paperId ?? "";
    return id.slice(id.lastIndexOf("-") + 1).slice(0, 4);
  });
}

/** Distinct pages and documents a stretch's calls returned. */
export function stretchPages(stretch: TraceStretch): number {
  const seen = new Set<string>();
  for (const entry of stretch.entries) {
    if (entry.kind !== "tool") continue;
    for (const result of toolPhrase(entry).results) seen.add(result.slug ?? result.paperId ?? result.url ?? result.title);
  }
  return seen.size;
}

/**
 * The fold's one line: how long, how much, and whether pages came of it.
 *
 * "Thought for" when the model said anything about its work; "Worked for"
 * when it sent no thoughts and the stretch is calls alone, counted as lookups
 * when that is all they were. Context is never a step: it is what the answer
 * was handed, not something it did.
 */
export function foldSummary(stretch: TraceStretch, now?: number): string {
  const rows = stretchRows(stretch);
  const tools = rows.filter((entry): entry is ToolEntry => entry.kind === "tool");
  const thought = rows.length > tools.length;
  // A call asked for before the answer resumed may outrun the stretch.
  const end = Math.max(stretch.endedAt ?? now ?? stretch.startedAt, ...tools.map((entry) => entry.at + (entry.ms ?? 0)));
  const duration = formatClock(Math.max(0, end - stretch.startedAt));
  const lookups = tools.length > 0 && tools.every((entry) => traceTool(entry).lookup);
  const pages = stretchPages(stretch);
  return [
    `${thought ? "Thought" : "Worked"} for ${duration}`,
    rows.length ? plural(rows.length, !thought && lookups ? "lookup" : "step") : "",
    pages ? plural(pages, "page") : "",
  ].filter(Boolean).join(" · ");
}

/**
 * A context row: a glyph, what it names, a quieter remark after it, and any
 * pages under it. `at` is when it became true, for the one row the reader
 * waited on; `running` marks that row while the wait is still going.
 */
export type ContextRow = { glyph: TraceGlyph; label: string; detail: string; results?: TraceResult[]; at?: number; running?: boolean };

const START_LABELS: Record<TraceContext["start"]["kind"], string> = {
  question: "Your question",
  page: "Memory page",
  document: "Open document",
  project: "Project",
};

/**
 * What the answer was handed, as the rows that say so. `live` is whether the
 * answer is still being reached: choosing from Memory is only ever under way
 * in one that is.
 */
export function contextRows(context: TraceContext | undefined, live = false): ContextRow[] {
  if (!context) return [];
  const { start, index } = context;
  const rows: ContextRow[] = [
    {
      glyph: start.kind === "question" ? "question" : start.kind === "page" ? "page" : "document",
      label: START_LABELS[start.kind] ?? START_LABELS.question,
      detail: start.kind === "question" ? "nothing open beside the chat" : start.title ?? "",
    },
  ];
  if (index) {
    const counts = [
      index.pages !== undefined ? plural(index.pages, "page") : "",
      index.documents !== undefined ? plural(index.documents, "document") : "",
      index.chats !== undefined ? plural(index.chats, "chat") : "",
    ].filter(Boolean);
    if (counts.length) rows.push({ glyph: "index", label: `Index: ${counts.join(" · ")}`, detail: "" });
  }
  // Pages Delphi put in the request are what the answer was handed, not a
  // call it made, so they are said here and never counted as a step.
  // Said only where the reader waited on it; a stored answer from before has no time to give.
  const at = context.memoryMs === undefined ? {} : { at: context.memoryMs };
  if (context.given?.length) {
    rows.push({
      glyph: "pages",
      label: `Given ${plural(context.given.length, "page")} from your Memory`,
      detail: "",
      results: context.given,
      ...at,
    });
  } else if (context.memory === "unavailable") {
    rows.push({ glyph: "pages", label: "Memory", detail: "could not be consulted before this answer", ...at });
  } else if (context.memory === "none") {
    rows.push({ glyph: "pages", label: "Nothing in Memory bears on this", detail: "", ...at });
  } else if (context.memory === "choosing" && live) {
    rows.push({ glyph: "pages", label: "Choosing from your Memory", detail: "", running: true });
  }
  return rows;
}

/** How long each waiting phrase is shown before the next rolls in, and how often the clock is re-read. */
export const TRACE_TIMING = { phraseHoldMs: 2400, tickMs: 250 } as const;

/**
 * Rows a running stretch shows above its active row. Older ones fold into a
 * single "N earlier" line, so a long stretch does not push the answer down
 * while it is written; the finished fold shows every row.
 */
export const TRACE_LIVE_VISIBLE = 3;

/** Which of a running stretch's rows are drawn: the last few, and how many came before. */
export function liveWindow<T>(rows: T[], visible = TRACE_LIVE_VISIBLE): { earlier: number; shown: T[] } {
  const earlier = Math.max(0, rows.length - visible);
  return { earlier, shown: rows.slice(earlier) };
}

/**
 * The record of the answer being written, as this tab holds it: the stretches
 * so far, and when the request was sent on the reader's own clock — the record
 * counts from the request, and a running clock has to count from somewhere
 * the reader's machine knows.
 */
export type LiveTrace = {
  startedAt: number;
  stretches: AnswerTrace;
  /** A wait that is not work, which the waiting row explains on hover. */
  waitingForCapacity?: boolean;
};

export const EMPTY_LIVE_TRACE: LiveTrace = { startedAt: 0, stretches: [] };
