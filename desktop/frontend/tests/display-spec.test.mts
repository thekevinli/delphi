import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { displayState, isDisplaySource, mathSegments, parseDisplay, type Display } from "../app/lib/display-spec.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../core/tests/data/displays/${name}.json`, import.meta.url), "utf8");
const correction = parseDisplay(fixture("correction")) as Display;
type Lanes = { lanes: { rows: { items: Record<string, unknown>[] }[] }[] };
const corrector = (step: number, variant: string) => (displayState(correction, step, variant).figures[0] as unknown as Lanes).lanes[1].rows[0].items[3];

test("every library example parses, and only a JSON object that opens with its version is a display", () => {
  for (const name of ["correction", "handbook", "isoflop", "moe", "omni"]) assert.ok(parseDisplay(fixture(name)), name);
  assert.equal(isDisplaySource("<svg></svg>"), false);
  assert.equal(isDisplaySource('{"title":"T","display":1}'), false);
  assert.equal(isDisplaySource('  {\n "display": 1, "title": "T"}'), true);
  assert.equal(parseDisplay('{"display":1, nope}'), null);
  // An absent field written as null is still absent.
  assert.ok(parseDisplay('{"display":1,"title":"T","steps":null,"control":null,"figures":[{"kind":"flow","lanes":[]}]}'));
  assert.equal(parseDisplay('{"display":1,"title":"T","figures":[]}'), null);
  assert.equal(parseDisplay('{"display":1,"title":"T","figures":[{"kind":"table"}]}'), null);
  // A default that is not one of the options would leave no tab pressed.
  assert.equal(parseDisplay('{"display":1,"title":"T","figures":[{"kind":"flow","lanes":[]}],"control":{"label":"K","default":"z","options":[{"value":"a","label":"A"}]}}'), null);
});

test("steps accumulate under the control's patch, and each state is a fresh copy", () => {
  assert.deepEqual(corrector(3, "k0").repeat, { count: "×0", off: true });
  assert.deepEqual(corrector(3, "k2").repeat, { count: "×2", run: true });
  assert.deepEqual(corrector(4, "k2").repeat, { count: "×2" });
  const final = (step: number) => (displayState(correction, step, "k2").figures[1] as { hidden?: boolean }).hidden;
  assert.equal(final(5), true);
  assert.equal(final(6), false);
  // Drawing a later state never leaks into an earlier one or into the spec.
  assert.equal(final(5), true);
  assert.equal((correction.figures[1] as { hidden?: boolean }).hidden, true);
  // Out-of-range steps clamp rather than throw.
  assert.deepEqual(displayState(correction, 99, "k2"), displayState(correction, 6, "k2"));
  assert.deepEqual(displayState(correction, -1, "k2"), displayState(correction, 0, "k2"));
});

test("a step's name and note follow the chosen option", () => {
  const noted = correction.steps!.find(step => typeof step.note !== "string")!;
  const at = correction.steps!.indexOf(noted);
  const notes = noted.note as Record<string, string>;
  assert.equal(displayState(correction, at, "k0").stepNote, notes.k0);
  assert.equal(displayState(correction, at, "k2").stepNote, notes.k2);
});

test("inline math splits on unescaped dollars, and an unclosed one stays text", () => {
  assert.deepEqual(mathSegments("loss $\\mathcal{L}$ falls"), [{ text: "loss " }, { math: "\\mathcal{L}" }, { text: " falls" }]);
  assert.deepEqual(mathSegments("costs \\$5"), [{ text: "costs $5" }]);
  assert.deepEqual(mathSegments("a $b"), [{ text: "a " }, { text: "$b" }]);
  assert.deepEqual(mathSegments("$x_t$"), [{ math: "x_t" }]);
});

test("the renderer walks each display layout at its narrowest card, so its widths follow the stylesheet", () => {
  const css = readFileSync(new URL("../app/components/display/display.css", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../../core/delphi_core/artifacts/worker.py", import.meta.url), "utf8");
  const breakpoints = [...css.matchAll(/@container \(max-width: (\d+)px\)/g)].map(match => Number(match[1])).sort((a, b) => a - b);
  const walked = worker.match(/DISPLAY_BREAKPOINTS = \(([^)]*)\)/)![1].split(",").map(Number);
  // The worker adds 1px for a bare card and 3px inside a framed card's 1px border.
  assert.deepEqual(walked, breakpoints);
});
