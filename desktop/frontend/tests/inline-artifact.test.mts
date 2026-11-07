import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { visit } from "unist-util-visit";
import type { Code } from "mdast";
import { parseMarkdownSource } from "../app/lib/markdown-pipeline.ts";
import { artifactDocument, artifactFence, artifactHeight, ARTIFACT_MAX_LENGTH, ARTIFACT_MAX_HEIGHT, ARTIFACT_MIN_HEIGHT } from "../app/lib/inline-artifact.ts";
import { answerSegments, type AnswerTrace } from "../app/lib/answer-trace.ts";
import { answerMarkdown } from "../app/lib/answer-references.ts";
import { normalizeCitationMarkup } from "../app/lib/citations.ts";
import { unwrapCitedLinks } from "../app/lib/web-sources.ts";
import { artifactThemeValues, ARTIFACT_THEME_PROPERTIES } from "../app/lib/artifact-theme.ts";
import { edgeRevealPoints } from "../app/lib/artifact-motion.ts";
import { installArtifactResizeObserver } from "../app/lib/artifact-runtime.ts";
import { artifactBadge, artifactControls, artifactStep } from "../app/lib/artifact-controls.ts";
import { artifactNumber, artifactTicks } from "../app/lib/artifact-kit.ts";

function fences(markdown: string) {
  const nodes: Code[] = [];
  visit(parseMarkdownSource(markdown), "code", node => { nodes.push(node); });
  return nodes.map(node => artifactFence(markdown, node.position?.start.offset, node.position?.end.offset, node.value));
}

test("only explicit artifact fences opt in, and titles remain plain text", () => {
  const source = '<button onclick="this.textContent=42">Count</button>';
  const [plain, quoted, ordinary, example] = fences([
    `\`\`\`delphi-artifact Pipeline overlap\n${source}\n\`\`\``,
    `~~~delphi-artifact title="Queue & workers"\n${source}\n~~~`,
    `\`\`\`html\n${source}\n\`\`\``,
    `\`\`\`\`markdown\n\`\`\`delphi-artifact Example\n${source}\n\`\`\`\n\`\`\`\``,
  ].join("\n\n"));
  assert.deepEqual(plain, { title: "Pipeline overlap", source, closed: true, problem: null });
  assert.equal(quoted?.title, "Queue & workers");
  assert.equal(quoted?.problem, null);
  assert.equal(ordinary, null);
  assert.equal(example, null);
});

test("only Markdown's real closing delimiter completes a program", () => {
  const partials = [
    "```delphi-artifact Working\n<div>still writing</div>",
    "````delphi-artifact Working\n<div>still writing</div>\n```",
    "```delphi-artifact Working\n<div>still writing</div>\n~~~",
    "```delphi-artifact Working\n<div>still writing</div>\n    ```",
    "> ```delphi-artifact Working\n> <div>still writing</div>\n>     ```",
  ];
  for (const markdown of partials) assert.equal(fences(markdown)[0]?.problem, "incomplete", markdown);
  for (const markdown of [
    "```delphi-artifact Done\n<div>ready</div>\n````",
    "> ```delphi-artifact Done\n> <div>ready</div>\n> ```",
    "- ```delphi-artifact Done\n  <div>ready</div>\n  ```",
    "```delphi-artifact Done\r\n<div>ready</div>\r\n```",
  ]) assert.equal(fences(markdown)[0]?.problem, null, markdown);
});

test("chat normalizers never rewrite code in quoted, listed, long, or unfinished fences", () => {
  const body = '<script>const ticks = "```"; const caption = "(Paper, **Table 4**, p. 9)"; const link = "([example](https://example.com/source))";</script>';
  const sources = [{ title: "Example", url: "https://example.com/source" }];
  const examples = [
    `> \`\`\`delphi-artifact Example\n> ${body}\n> \`\`\``,
    `- \`\`\`delphi-artifact Example\n  ${body}\n  \`\`\``,
    `\`\`\`\`delphi-artifact Example\n${body}\n\`\`\`\n<p>End</p>\n\`\`\`\``,
    `> ~~~delphi-artifact Example\n> ${body}`,
    `    ${body}`,
    'Inline ``(Paper, **Table 4**, p. 9) and ([example](https://example.com/source))``.',
  ];
  for (const markdown of examples) {
    assert.equal(normalizeCitationMarkup(markdown), markdown);
    assert.equal(unwrapCitedLinks(markdown, sources), markdown);
    assert.equal(answerMarkdown(markdown, sources), markdown);
  }
  const quoted = examples[0];
  assert.equal(answerMarkdown(`Before (Paper, **Table 4**, p. 9).\n\n${quoted}\n\nAfter ([example](https://example.com/source)).`, sources),
    `Before (Paper, Table 4, p. 9).\n\n${quoted}\n\nAfter [example](https://example.com/source).`);
});

test("empty and oversized artifacts get an honest fallback", () => {
  assert.equal(fences("```delphi-artifact\n```")[0]?.problem, "empty");
  assert.equal(fences(`\`\`\`delphi-artifact\n${"x".repeat(ARTIFACT_MAX_LENGTH + 1)}\n\`\`\``)[0]?.problem, "too-large");
  assert.equal(fences("```delphi-artifact\n<div>ready</div>\n```")[0]?.title, "Interactive visualization");
});

test("frame measurements cannot become invalid or unbounded layout", () => {
  for (const value of [null, undefined, "100", 0, -100, NaN, Infinity, {}]) assert.equal(artifactHeight(value), null);
  assert.equal(artifactHeight(1), ARTIFACT_MIN_HEIGHT);
  assert.equal(artifactHeight(280.2), 281);
  assert.equal(artifactHeight(1e12), ARTIFACT_MAX_HEIGHT);
});

test("header controls accept only bounded text, explicit disabled state and a current revision", () => {
  const valid = { revision: 3, back: { label: "Previous step", disabled: true }, next: { label: "Next", disabled: false }, progress: "1 / 4" };
  assert.deepEqual(artifactControls(valid), valid);
  assert.deepEqual(artifactControls({ ...valid, html: "<script>ignored</script>", action: "open-url" }), valid);
  for (const value of [
    null, [], "stepper", {}, { ...valid, revision: 0 }, { ...valid, revision: Infinity }, { ...valid, revision: 1.5 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, progress: "x".repeat(65) }, { ...valid, progress: "step\n2" },
    { ...valid, back: { label: "", disabled: false } }, { ...valid, back: { label: "  ", disabled: false } },
    { ...valid, next: { label: "x".repeat(33), disabled: false } }, { ...valid, next: { label: "Next", disabled: "false" } },
    { ...valid, back: null }, { ...valid, next: { label: { toString: () => "Next" }, disabled: false } },
  ]) assert.equal(artifactControls(value), null);
  valid.next.label = "<img src=x>";
  assert.equal(artifactControls(valid)?.next.label, "<img src=x>", "labels stay plain React text, never markup");
});

test("progress text yields a step count and name only when it states a real count", () => {
  assert.deepEqual(artifactStep("Training · 2 / 4"), { current: 2, total: 4, name: "Training" });
  assert.deepEqual(artifactStep("Step 3 of 8"), { current: 3, total: 8, name: "" });
  assert.deepEqual(artifactStep("L1 hit · 1 / 3"), { current: 1, total: 3, name: "L1 hit" });
  assert.deepEqual(artifactStep("Sampling 12 / 46 · t 0.7"), { current: 12, total: 46, name: "Sampling · t 0.7" });
  assert.deepEqual(artifactStep("2/5 (Retry after 2 s)"), { current: 2, total: 5, name: "Retry after 2 s" });
  for (const text of ["Warming up", "5 / 4", "0 / 4", "1 / 1", "1 / 400", "t = 0.7", ""]) assert.equal(artifactStep(text), null, text);
});

test("a diagram's badge is one of the listed disclosures, never its own claim", () => {
  assert.equal(artifactBadge(" toy data "), "Toy data");
  assert.equal(artifactBadge("Schematic"), "Schematic");
  for (const value of ["Verified", "Peer reviewed", "", 3, null]) assert.equal(artifactBadge(value), "");
});

test("kit numbers never show float noise and axes use round steps or decades", () => {
  assert.equal(artifactNumber(0.7300000001), "0.73");
  assert.equal(artifactNumber(66, "int"), "66");
  assert.equal(artifactNumber(12345.6), "12,346");
  assert.equal(artifactNumber(0.6, "percent"), "60%");
  assert.equal(artifactNumber(1.5, "0.0", "ms"), "1.5 ms");
  assert.equal(artifactNumber(null), "—");
  assert.deepEqual(artifactTicks(0, 66), { domain: [0, 80], ticks: [0, 20, 40, 60, 80] });
  assert.deepEqual(artifactTicks(0, 1).ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(artifactTicks(0.05, 3.1, "log"), { domain: [0.01, 10], ticks: [0.01, 0.1, 1, 10] });
  assert.deepEqual(artifactTicks(2, 40, "log").ticks, [1, 2, 5, 10, 20, 50, 100]);
  assert.deepEqual(artifactTicks(5, 5).domain[0], 0);
});

test("documents install the policy and trusted bootstrap before model markup", () => {
  const model = '<div id="diagram">Diagram</div><script>document.body.dataset.ran="yes"</script>';
  const document = artifactDocument(model, '</title><script>alert("title")</script>');
  assert.ok(document.indexOf("Content-Security-Policy") < document.indexOf(model));
  assert.ok(document.indexOf("RTCPeerConnection") < document.indexOf(model));
  assert.match(document, /default-src &#39;none&#39;/);
  assert.match(document, /connect-src &#39;none&#39;/);
  assert.match(document, /form-action &#39;none&#39;/);
  assert.match(document, /&lt;\/title&gt;&lt;script&gt;/);
  assert.ok(document.includes(model), "interactive source is isolated, not rewritten");
  const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(bootstrap);
  assert.doesNotThrow(() => new Script(bootstrap));
});

test("streamed previews grant script execution only to their unguessable bootstrap", () => {
  const nonce = "testPreviewNonce0123456789";
  const model = '<div>Drawing</div><script>throw new Error("must not run")</script>';
  const document = artifactDocument(model, "Preview", { previewNonce: nonce });
  assert.match(document, /script-src &#39;nonce-testPreviewNonce0123456789&#39;/);
  assert.doesNotMatch(document, /script-src &#39;unsafe-inline&#39;/);
  assert.equal(document.split(`nonce="${nonce}"`).length, 2, "only bootstrap has a nonce");
  const bootstrap = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(bootstrap);
  assert.doesNotThrow(() => new Script(bootstrap));
  assert.doesNotMatch(bootstrap, /securitypolicyviolation/);
  assert.doesNotMatch(bootstrap, /DelphiArtifact|artifactMotion|edge-mask|installArtifactResizeObserver|installArtifactControls|delphi-artifact-control/);
  assert.throws(() => artifactDocument(model, "Preview", { previewNonce: "x' 'unsafe-inline" }));
});

test("frame-local resize deliveries coalesce targets and cancel unobserved work without swallowing errors", () => {
  type Target = { name: string };
  type Entry = { target: Target; size: number };
  class NativeObserver {
    observed = new Map<Target, unknown>();
    callback: (entries: Entry[], observer: NativeObserver) => void;
    constructor(callback: (entries: Entry[], observer: NativeObserver) => void) { this.callback = callback; }
    observe(target: Target, options?: unknown) { this.observed.set(target, options); }
    unobserve(target: Target) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
    emit(entries: Entry[]) { this.callback(entries, this); }
  }
  let identity = 0;
  const frames = new Map<number, () => void>();
  const environment = {
    window: { ResizeObserver: NativeObserver },
    requestAnimationFrame(callback: () => void) { const id = ++identity; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  new Script(`(${installArtifactResizeObserver.toString()})();`).runInNewContext(environment);
  const Wrapped = environment.window.ResizeObserver;
  const flush = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(); };
  const a = { name: "a" }, b = { name: "b" }, options = { box: "border-box" };
  const received: Entry[][] = [];
  const observer = new Wrapped(function(this: NativeObserver, entries, sender) {
    assert.equal(this, observer);
    assert.equal(sender, observer);
    received.push(Array.from(entries));
    if (received.length === 1) observer.emit([{ target: a, size: 4 }]);
  });
  assert.ok(observer instanceof NativeObserver);
  observer.observe(a, options); observer.observe(b);
  assert.equal(observer.observed.get(a), options);
  observer.emit([{ target: a, size: 1 }, { target: b, size: 2 }]);
  observer.emit([{ target: a, size: 3 }]);
  assert.equal(received.length, 0);
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(received[0], [{ target: a, size: 3 }, { target: b, size: 2 }]);
  assert.equal(frames.size, 1, "callback writes can schedule another frame");
  flush();
  assert.deepEqual(received[1], [{ target: a, size: 4 }]);
  observer.emit([{ target: a, size: 5 }, { target: b, size: 6 }]);
  observer.unobserve(a); flush();
  assert.deepEqual(received[2], [{ target: b, size: 6 }]);
  observer.emit([{ target: b, size: 7 }]); observer.disconnect();
  assert.equal(frames.size, 0);
  assert.equal(observer.observed.size, 0);
  observer.observe(a); observer.emit([{ target: a, size: 8 }]); observer.unobserve(a);
  assert.equal(frames.size, 0);
  const broken = new Wrapped(() => { throw new Error("callback failed"); });
  broken.observe(a); broken.emit([{ target: a, size: 9 }]);
  assert.throws(flush, /callback failed/);
});

test("artifact palette follows the host contract and accepts only bounded CSS values", () => {
  const host = new Map([
    ["--paper", "#fefdfb"], ["--canvas", "#f4f1ef"], ["--ink", "#241412"], ["--muted", "#887b78"], ["--line", "#ddd5d0"],
    ["--clay", "#5a2620"], ["--dawn", "#ee9d66"], ["--moss", "#3e7bc9"], ["--moss-dark", "#244f86"],
    ["--cloud", "#3e7bc9"], ["--saffron", "#e0a020"], ["--coral", "#c94e3a"],
    ["--chat-card-radius", "8px"], ["--font-sans", '"Plus Jakarta Sans", sans-serif'], ["--irrelevant", "private"],
  ]);
  const values = artifactThemeValues({ getPropertyValue: key => host.get(key) ?? "" });
  assert.equal(values["--artifact-bg"], "#fefdfb");
  assert.equal(values["--artifact-accent"], "#5a2620");
  assert.equal(values["--artifact-cool-ink"], "#244f86");
  assert.equal(values["--artifact-radius"], "8px");
  assert.equal(values["--artifact-font"], '"Plus Jakarta Sans", sans-serif');
  assert.equal(values["--artifact-accent-soft"], "color-mix(in srgb, #5a2620 14%, #fefdfb)");
  assert.equal(values["--artifact-warm"], "color-mix(in srgb, #ee9d66 26%, #fefdfb)");
  assert.equal(values["--artifact-cool"], "color-mix(in srgb, #3e7bc9 20%, #fefdfb)");
  assert.equal(values["--artifact-muted"], "color-mix(in srgb, #887b78 80%, #241412)");
  assert.equal(values["--artifact-role-current"], "#ee9d66");
  assert.deepEqual(Object.keys(values).sort(), [...ARTIFACT_THEME_PROPERTIES].sort());
  host.set("--paper", "red; background:url(https://example.com)");
  host.set("--font-sans", "x".repeat(501));
  const refused = artifactThemeValues({ getPropertyValue: key => host.get(key) ?? "" });
  assert.equal(refused["--artifact-bg"], undefined);
  assert.equal(refused["--artifact-font"], undefined);
  assert.equal(refused["--artifact-accent-soft"], undefined);
});

test("edge reveal follows source order instead of assuming left-to-right geometry", () => {
  const rtl = edgeRevealPoints(160, distance => ({ x: 200 - distance, y: 40 }));
  assert.equal(rtl[0].x, 200);
  assert.equal(rtl.at(-1)?.x, 40);
  assert.ok(rtl.every((point, index) => index === 0 || point.x < rtl[index - 1].x));
  // The returned positions follow the supplied arc-length traversal, including
  // a curve whose x direction reverses halfway along its route.
  const curve = edgeRevealPoints(200, distance => ({ x: 100 + Math.sin(distance / 200 * Math.PI) * 70, y: 30 + distance / 2 }));
  assert.equal(curve[0].y, 30);
  assert.equal(curve.at(-1)?.y, 130);
  assert.ok(curve.every((point, index) => index === 0 || point.at > curve[index - 1].at));
  assert.ok(curve[Math.floor(curve.length / 2)].x > curve[0].x);
  assert.ok(Math.abs(curve.at(-1)!.x - curve[0].x) < .001);
});

test("motion geometry is bounded and unusable paths degrade without allocations", () => {
  assert.ok(edgeRevealPoints(90_000, distance => ({ x: distance, y: 0 })).length <= 48);
  for (const length of [0, -1, Infinity, NaN, 100_001]) assert.deepEqual(edgeRevealPoints(length, () => { throw new Error("must not sample"); }), []);
  assert.deepEqual(edgeRevealPoints(20, () => ({ x: Infinity, y: 0 })), []);
  assert.ok(edgeRevealPoints(1, distance => ({ x: distance, y: 0 })).every(point => Number.isFinite(point.radius) && point.radius > 0));
});

test("trace work never divides a long artifact fence or mistakes its nested example for the end", () => {
  const artifact = "````delphi-artifact Example\n<div>Before</div>\n```\n<div>After</div>\n````";
  const content = `Introduction.\n\n${artifact}\n\nConclusion.`;
  const trace: AnswerTrace = [{ offset: content.indexOf("<div>Before"), startedAt: 0, endedAt: 1000, entries: [{ kind: "thought", at: 0, text: "Working" }] }];
  const pieces = answerSegments(content, trace);
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0].kind, "text");
  if (pieces[0].kind === "text") {
    assert.ok(pieces[0].text.includes(artifact));
    assert.equal(fences(pieces[0].text)[0]?.problem, null);
  }
  assert.equal(pieces[1].kind, "work");
  assert.equal(pieces[2].kind === "text" && pieces[2].text.trim(), "Conclusion.");
});

test("only a diagram that declares something the kit draws carries the kit's script", () => {
  const kit = (source: string) => artifactDocument(source).includes("delphi-artifact-arrow");
  assert.equal(kit("<svg><rect width='4' height='4'/></svg>"), false);
  assert.equal(kit("<div data-artifact-chart='{}'></div>"), true);
  assert.equal(kit("<div id='c'></div><script>c.dataset.artifactChart = '{}'</script>"), true);
  assert.equal(kit("<span data-artifact-from='a'></span>"), true);
  assert.equal(kit("<div DATA-ARTIFACT-CHART='{}'></div>"), true);
  assert.equal(kit("<script>for (const k of ['chart']) el.setAttribute('data-artifact-' + k, '{}')</script>"), true);
  assert.equal(kit("<div data-artifact-controls='header'><output data-artifact-progress>1 / 2</output></div>"), false);
});
