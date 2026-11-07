import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the Dashboard lands where the server's onboarding record says", async () => {
  const dashboard = await read("../app/components/Dashboard.tsx");
  // Not "no projects": an interrupted attempt has projects and still restarts.
  assert.doesNotMatch(dashboard, /!data\.projects\.length && !data\.conversations\.length/);
  assert.match(dashboard, /api<\{ onboarding: boolean \}>\("\/api\/onboarding\/resolve", \{ method: "POST" \}\)/);
  // Resolve first, then the library: resolving may just have deleted projects.
  assert.match(dashboard, /\.then\(async \(landing\) => \[landing, await api<DashboardData>\("\/api\/dashboard"\)\] as const\)/);
  // The flow is the whole window: the rail is rendered only on the other
  // branch, and a first run keeps a strip to drag the window by.
  assert.match(dashboard, /onboarding \? <>\s*<div className="desktop-window-drag" aria-hidden="true" \/>\s*<Onboarding config=\{config\}/);
  assert.match(dashboard, /: <>\s*<DashboardRail/);
  const css = await read("../app/globals.css");
  // No rail padding, and no rail width for `.dashboard-wrap` to leave room for.
  assert.match(css, /\.dashboard-shell\.is-onboarding \{ --desktop-rail-width: 0px; padding-left: 0; \}/);
});

test("every project onboarding makes is recorded on the attempt", async () => {
  const onboarding = await read("../app/components/Onboarding.tsx");
  const creations = onboarding.match(/api<Project>\("\/api\/projects", \{[\s\S]*?\}\)/g) ?? [];
  assert.equal(creations.length, 2, "bookmark projects and the manual project");
  for (const call of creations) assert.match(call, /onboarding: true/);
});

test("the last screen waits for a completed document before letting the reader in", async () => {
  const onboarding = await read("../app/components/Onboarding.tsx");
  assert.match(onboarding, /api<Readiness>\("\/api\/onboarding"\)/);
  assert.match(onboarding, /api<\{ complete: boolean \}>\("\/api\/onboarding\/finish", \{ method: "POST" \}\)/);
  assert.match(onboarding, /disabled=\{!ready && !filingFailed\}/);
  assert.match(onboarding, /if \(finishing \|\| \(!ready && !filingFailed\)\) return;/);
  // Failed filing offers a restart, never successful completion.
  assert.match(onboarding, /return \(readiness\.completed \?\? 0\) > 0;/);
  assert.match(onboarding, /filingFailed \? "Start again" : "Enter Delphi"/);
});

test("when every bookmark fails, Continue and Enter both lead to manual setup", async () => {
  const onboarding = await read("../app/components/Onboarding.tsx");
  assert.match(onboarding, /Bookmark imports failed: \{importFailure\}\. You can still create a new project manually\./);
  // The visible button and the Enter handler take the same branch.
  assert.match(onboarding, /<Actions label="Continue" onClick=\{\(\) => added\.projects \? go\("finale"\) : continueManually\(\)\} \/>/);
  assert.match(onboarding, /if \(added\.projects\) go\("finale"\);\s*else continueManually\(\);/);
  assert.doesNotMatch(onboarding, /<Actions label="Continue" disabled=\{!added\.projects\}/);
});

test("a webpage is its own step, optional only once PDFs are in", async () => {
  const onboarding = await read("../app/components/Onboarding.tsx");
  assert.match(onboarding, /webImports \? \["webpage" as const\] : \[\]/);
  assert.match(onboarding, /route === "manual" && webImports \? <Step id="webpage"/);
  // The PDF step can be skipped to reach it.
  assert.match(onboarding, /disabled=\{!files.length && !webImports\}/);
  assert.match(onboarding, /go\(webImports \? "webpage" : "finale"\)/);
  // The webpage step skips only when documents already landed.
  assert.match(onboarding, /disabled=\{!pageUrl\.trim\(\) && !added\.documents\}/);
  assert.match(onboarding, /if \(pageUrl\.trim\(\)\) void runWebpage\(\);\s*else if \(added\.documents\) go\("finale"\);/);
});
