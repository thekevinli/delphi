import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PROJECT_PALETTE, accentRamp, onRampStep } from "../app/lib/project-color.ts";

const orchid = "#8e4a9c";

test("a project's ramp runs from its accent to a pastel of the same hue, in order", () => {
  const ramp = accentRamp(orchid, 4);
  assert.equal(ramp.length, 4);
  assert.equal(ramp[0], orchid);
  assert.equal(ramp.at(-1), "#d9c1dd");
  // Each step is lighter than the one above it, and every step keeps the
  // accent's hue: the same channel stays the weakest all the way down.
  const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  for (let index = 1; index < ramp.length; index += 1) {
    const [above, below] = [channels(ramp[index - 1]), channels(ramp[index])];
    assert.ok(below.every((channel, at) => channel > above[at]), `${ramp[index]} is lighter than ${ramp[index - 1]}`);
    assert.equal(below.indexOf(Math.min(...below)), 1);
  }
  assert.deepEqual(accentRamp(orchid, 1), [orchid]);
  assert.deepEqual(accentRamp(orchid, 0), []);
});

test("every accent has a ramp without being listed, so the palette can change freely", () => {
  for (const accent of [...PROJECT_PALETTE, "#2a9d8f"]) {
    const ramp = accentRamp(accent, 6);
    assert.equal(ramp[0], accent);
    assert.ok(ramp.every((step) => /^#[0-9a-f]{6}$/.test(step)));
  }
});

test("a chip's letter reads on every step: white, then a deep shade of the same accent", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (one: string, other: string) => {
    const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };
  for (const accent of PROJECT_PALETTE) {
    for (const step of accentRamp(accent, 8)) {
      const letter = onRampStep(accent, step);
      assert.ok(contrast(letter, step) >= 3, `${accent} on ${step}`);
      // Never the neutral brown for a palette colour: a light chip keeps its
      // letter in the project's family.
      assert.notEqual(letter, "#241412", `${accent} on ${step}`);
    }
  }
  const ramp = accentRamp(orchid, 4);
  assert.equal(onRampStep(orchid, ramp[0]), "#ffffff");
  assert.equal(onRampStep(orchid, ramp.at(-1)!), "#542c50");
});

test("the collapsed library colours its documents from the open project's ramp", async () => {
  const workspace = await readFile(new URL("../app/components/Workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /const railRamp = accentRamp\(accent\(project\?\.id\), orderedPapers\.length\);/);
  assert.match(workspace, /"--paper-color": railRamp\[index\],/);
  // Not the palette by position, which painted each document a different project's colour.
  assert.doesNotMatch(workspace, /"--paper-color": accentAt\(index\)/);
});
