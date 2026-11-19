/**
 * The browser fixtures and `api.ts` hold the backend's real Memory answers.
 *
 *   node --test --experimental-strip-types tests/recorded/recorded.test.mts
 *
 * The answers are `responses.json`, recorded by `record.mts` from the pinned
 * backend. `known-differences.json` lists the disagreements there were when the
 * check was written, each under why it is accepted. Any other disagreement
 * fails here, and so does a listed one that has gone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check, fixtureFiles, frontendMemoryRoutes, loadRecording, routePathKey, ROUTES, UNRECORDED, type Recording, type Result } from "./shapes.mts";

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const known = JSON.parse(readFileSync(file("./known-differences.json"), "utf8")) as Record<string, string | string[]>;
const knownIds = Object.entries(known).filter(([, ids]) => Array.isArray(ids)).flatMap(([, ids]) => ids as string[]);
const baseline = check();
const baselineIds = new Set(baseline.findings.map(finding => finding.id));
/** What a changed file or recording adds to today's findings. */
const added = (result: Result) => result.findings.map(finding => finding.id).filter(id => !baselineIds.has(id));

/** A file's text with one passage replaced, failing if the passage is no longer there. */
function edited(path: string, before: string, after: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(before), `${path} no longer holds ${JSON.stringify(before)}; pick another passage for this test`);
  return { [path]: text.replace(before, after) };
}

test("the recordings are the core's", () => {
  const version = readFileSync(file("../../../../core/pyproject.toml"), "utf8").match(/^version = "(.+)"$/m)?.[1];
  assert.equal(loadRecording().backend, version, "core/ is at another version: run record.mts again");
});

test("every Memory route the frontend calls is recorded, or answers bytes", () => {
  const described = new Set([...Object.keys(ROUTES), ...UNRECORDED].map(routePathKey));
  assert.deepEqual(frontendMemoryRoutes().filter(route => !described.has(route.path)), [],
    "a route here is called by the frontend and recorded by nothing: record it in record.mts and describe it in ROUTES");
});

test("every browser file that serves a Memory route is read for its fixtures", () => {
  const read = new Set(baseline.sites.map(site => site.label.split(" ")[0]));
  const serving = fixtureFiles().filter(path => /["'`*]\*?\/api\/memory\//.test(readFileSync(path, "utf8")))
    .map(path => path.split("/").at(-1)!);
  assert.deepEqual(serving.filter(name => !read.has(name)), [], "these files mention a Memory route but no fixture was found in them");
});

test("the fixtures and api.ts agree with the backend's answers, but for the differences already known", t => {
  for (const line of baseline.unchecked) t.diagnostic(`not checked: ${line}`);
  t.diagnostic(`${baseline.sites.length} fixture sites checked`);
  const unexpected = baseline.findings.filter(finding => !knownIds.includes(finding.id));
  const gone = knownIds.filter(id => !baselineIds.has(id));
  assert.deepEqual({ unexpected: unexpected.map(finding => finding.message), gone }, { unexpected: [], gone: [] },
    "Fix the fixture, the type or the backend, or, if the difference is meant, list its id in known-differences.json under why. "
    + `Ids of the unexpected:\n${unexpected.map(finding => JSON.stringify(finding.id)).join(",\n")}`);
});

const memorySpec = file("../browser/memory.spec.ts");

test("a fixture key renamed in a spec fails", () => {
  const result = check({ overrides: edited(memorySpec,
    "value = { pages: 3, computedAt: now, orphans: [], uncapturedFigures: [], droppedTargets: [], lastCheck: null };",
    "value = { pages: 3, computedOn: now, orphans: [], uncapturedFigures: [], droppedTargets: [], lastCheck: null };") });
  assert.deepEqual(added(result).sort(), [
    "memory.spec.ts (GET /api/memory/health #1) $.computedAt: fixture lacks a key api.ts requires",
    "memory.spec.ts (GET /api/memory/health #1) $.computedOn: fixture key the backend never sends",
  ]);
});

test("a key left out of a spec's fixture fails", () => {
  const result = check({ overrides: edited(memorySpec,
    "value = { pending: 0, leased: 0, cancellable: 0, failed: 0, due: 0, jobs: [], maxAttempts: 3 };",
    "value = { pending: 0, leased: 0, cancellable: 0, failed: 0, jobs: [], maxAttempts: 3 };") });
  assert.deepEqual(added(result), ["memory.spec.ts (GET /api/memory/maintenance #1) $.due: fixture lacks a key api.ts requires"]);
});

test("a key the backend renames fails, against api.ts and against the fixtures", () => {
  const renamed = (value: unknown): unknown => Array.isArray(value) ? value.map(renamed)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === "linkDegree" ? "linkCount" : key, renamed(entry)]))
    : value;
  const result = check({ recording: renamed(loadRecording()) as Recording });
  const ids = added(result);
  for (const id of [
    "GET /api/memory $.pages[].linkCount: recorded key not in the api.ts type",
    "GET /api/memory $.pages[].linkDegree: api.ts requires a key the backend does not always send",
    "memory.spec.ts (GET /api/memory #1) $.pages[].linkDegree: fixture key the backend never sends",
  ]) assert.ok(ids.includes(id), `missing ${id} among:\n${ids.join("\n")}`);
});

test("a key renamed in api.ts fails", () => {
  const result = check({ overrides: edited(file("../../app/lib/api.ts"), "  memoryRelatedHops: number;", "  memoryHops: number;") });
  const ids = added(result);
  for (const id of [
    "GET /api/config $.memoryRelatedHops: recorded key not in the api.ts type",
    "GET /api/config $.memoryHops: api.ts requires a key the backend does not always send",
  ]) assert.ok(ids.includes(id), `missing ${id} among:\n${ids.join("\n")}`);
});
