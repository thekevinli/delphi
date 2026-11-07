import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

/** The CSS of one section of globals.css, from its heading to the next one. */
function section(css: string, heading: string): string {
  const start = css.indexOf(`/* --- ${heading} `);
  assert.ok(start >= 0, `no "${heading}" section`);
  const next = css.indexOf("/* --- ", start + 1);
  return css.slice(start, next < 0 ? undefined : next);
}

test("loading moves by transform and opacity only, and holds still under reduced motion", async () => {
  const css = section(await read("../app/globals.css"), "Loading");
  const frames = [...css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)];
  const names = frames.map(([, name]) => name);
  for (const name of ["sweep-text-window", "sweep-text-shine", "skeleton-pass", "pages-mark-lift", "graph-mark-edge-1", "graph-mark-node-0", "graph-mark-ring-0"]) {
    assert.ok(names.includes(name), `missing @keyframes ${name}`);
  }
  for (const [, name, body] of frames) {
    // A keyframe may also say how to ease into the next one; that is timing, not a property.
    const properties = [...body.matchAll(/([a-z-]+):/g)].map((match) => match[1])
      .filter((property) => property !== "animation-timing-function");
    assert.ok(properties.every((property) => property === "transform" || property === "opacity"), `${name} animates ${properties.join(", ")}`);
  }
  // The window and the copy inside it travel the same distance in opposite
  // directions, so the letters never move.
  assert.match(css, /@keyframes sweep-text-window \{\s*from \{ transform: translateX\(-112%\); \}\s*to \{ transform: translateX\(112%\); \}/);
  assert.match(css, /@keyframes sweep-text-shine \{\s*from \{ transform: translateX\(112%\); \}\s*to \{ transform: translateX\(-112%\); \}/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const selector of [".sweep-text-window", ".skeleton::after", ".graph-mark-ring", ".pages-mark-sheet", ".graph-mark-edge", ".graph-mark-node"]) {
    assert.ok(reduced.includes(selector), `${selector} still moves under reduced motion`);
  }
});

test("every step of the graph walk has its keyframes", async () => {
  const [mark, css] = await Promise.all([read("../app/components/Loading.tsx"), read("../app/globals.css")]);
  const loading = section(css, "Loading");
  const nodeSteps = new Set([...mark.matchAll(/\{ vertex: \d+, step: (\d)/g)].map(([, step]) => step));
  const edgeSteps = new Set([...mark.matchAll(/to: [\w().]+, step: (\d)/g)].map(([, step]) => step));
  assert.deepEqual([...nodeSteps], ["0", "1", "2"]);
  assert.deepEqual([...edgeSteps], ["1", "2", "3"]);
  for (const step of nodeSteps) {
    assert.match(loading, new RegExp(`\\.graph-mark-node\\.is-step-${step} \\{ animation-name: graph-mark-node-${step}; \\}`));
    assert.match(loading, new RegExp(`\\.graph-mark-ring\\.is-step-${step} \\{ animation-name: graph-mark-ring-${step}; \\}`));
  }
  for (const step of edgeSteps) {
    assert.match(loading, new RegExp(`\\.graph-mark-edge\\.is-step-${step} \\{ animation-name: graph-mark-edge-${step}; \\}`));
  }
  // A pentagon, its mirror pairs sharing a kind.
  assert.match(mark, /sides: 5/);
  for (const kind of ["domain", "source", "question"]) {
    assert.match(loading, new RegExp(`\\.graph-mark \\.is-${kind} \\{ --graph-mark-kind: var\\(--graph-mark-${kind}\\); \\}`));
  }
});

test("regions show their shape, and the Delphi mark stays where it already works", async () => {
  const [dashboard, canvas, rail, settings, annotations, trace, workspace, notice] = await Promise.all([
    read("../app/components/Dashboard.tsx"),
    read("../app/components/MemoryGraphCanvas.tsx"),
    read("../app/components/chat/ConversationRail.tsx"),
    read("../app/components/SettingsModal.tsx"),
    read("../app/components/AnnotationsPanel.tsx"),
    read("../app/components/AnswerTrace.tsx"),
    read("../app/components/Workspace.tsx"),
    read("../app/components/Notice.tsx"),
  ]);
  // Home: the real sections, outlined, the Memory card growing the graph.
  assert.match(dashboard, /role="status">\s*<LoadingWords text="Loading your Delphi" \/>/);
  for (const name of ["Recent threads", "Memory", "Projects"]) assert.match(dashboard, new RegExp(`<h2>${name}</h2>`));
  assert.match(dashboard, /DASHBOARD_THREAD_LIMIT \}, \(_, index\) => <ThreadOutline/);
  assert.match(dashboard, /<div className="kb-graph-loading"><GraphMark \/><\/div>/);
  assert.doesNotMatch(dashboard, /delphi-loading-sunrise|useTypedDots/);
  assert.doesNotMatch(canvas, /delphi-loading-sunrise/);
  // Chat, Settings lists and the note: outlines, with no words to read.
  assert.match(rail, /: <ConversationsOutline \/>/);
  assert.doesNotMatch(rail, /Loading conversations…/);
  for (const list of ["library", "plans", "chats"]) {
    assert.match(settings, new RegExp(`<ListOutline label="Loading your ${list}" />`));
    assert.doesNotMatch(settings, new RegExp(`Loading your ${list}…`));
  }
  assert.match(annotations, /<Suspense fallback=\{<NoteOutline \/>\}>/);
  assert.doesNotMatch(annotations, /Opening editor…/);
  // One light for every waiting phrase, the trace's included.
  assert.match(trace, /import \{ SweepText \} from "\.\/Loading";/);
  assert.doesNotMatch(trace, /function SweepText/);
  // Kept: the climb for running work, and the sunrise for notices.
  assert.doesNotMatch(workspace, /delphi-loading-sunrise/);
  assert.match(notice, /running: "\/brand\/animations\/delphi-loading-climb\.gif"/);
});
