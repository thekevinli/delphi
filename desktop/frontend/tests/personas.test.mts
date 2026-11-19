import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_PERSONA_ID,
  PERSONA_ELEMENTS,
  personaElement,
} from "../app/lib/personas.ts";

test("falls back to a drawable element for anything unrecognised", () => {
  for (const element of PERSONA_ELEMENTS) {
    assert.equal(personaElement(element), element);
  }
  // A persona written by a newer client, or a field that arrived null. Either
  // way an unknown element must not render as a gap where an icon should be.
  assert.equal(personaElement("plasma"), "stone");
  assert.equal(personaElement(undefined), "stone");
  assert.equal(personaElement(null), "stone");
  assert.equal(personaElement(7), "stone");
});

test("the loading placeholder names the same persona the pill falls back to", async () => {
  // Two tests used to live here, and both asked whether an id was one of the
  // four shipped in code. That list is gone: `PersonaSummary.official` answers
  // it on the wire, so the client holds no catalogue to test.
  //
  // What is still worth pinning is the one persona id this side does spell out.
  // Before `/api/config` lands there is nothing to render a menu from, so
  // `PersonaPill` shows a single hardcoded row — and if that row's id and this
  // constant ever diverge, the first paint shows a persona the pill then cannot
  // find and silently replaces.
  const pill = await readFile(
    new URL("../app/components/ChatBits.tsx", import.meta.url),
    "utf8",
  );
  const fallback = pill.slice(
    pill.indexOf("const choices ="),
    pill.indexOf("const current ="),
  );
  assert.match(fallback, new RegExp(`id: DEFAULT_PERSONA_ID`));
  assert.equal(DEFAULT_PERSONA_ID, "mentor");
});

test("the persona menu groups by what the server says, not by a list of ids", async () => {
  // The grouping itself is a click-through check — the rows only exist once the
  // menu is open, and neither frontend has a harness that can open it. What can
  // be pinned here is that the split reads the wire field, because the failure
  // it replaced was a stale client-side catalogue quietly filing a new official
  // persona under "Your personas".
  const pill = await readFile(
    new URL("../app/components/ChatBits.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pill, /const official = choices\.filter\(\(persona\) => persona\.official\)/);
  assert.match(pill, /const mine = choices\.filter\(\(persona\) => !persona\.official\)/);
});

test("every element in the vocabulary has a colour to render with", async () => {
  // The icons read their colour from a `--element-*` token and never from a
  // fill. An element in the list with no token renders as a gap — and with
  // officials and your own personas now listed together, every one of the six
  // can appear in the same menu.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root"), css.indexOf("--kb-node-domain"));
  for (const element of PERSONA_ELEMENTS) {
    assert.match(root, new RegExp(`--element-${element}:`), element);
  }
});
