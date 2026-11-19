/** The full-screen signal the frontend's header layout depends on. */
import assert from "node:assert/strict";
import test from "node:test";

import { FULL_SCREEN_ATTRIBUTE, fullScreenScript } from "../main/fullscreen.ts";

function run(script: string, attributes: Set<string>): void {
  const documentElement = {
    toggleAttribute(name: string, force: boolean) {
      if (force) attributes.add(name); else attributes.delete(name);
    },
  };
  new Function("document", script)({ documentElement });
}

test("full screen is stamped on the root element and removed on leaving", () => {
  const attributes = new Set<string>();
  run(fullScreenScript(true), attributes);
  assert.deepEqual([...attributes], ["data-fullscreen"]);
  run(fullScreenScript(false), attributes);
  assert.equal(attributes.size, 0);
});

test("the attribute name is the one the stylesheet selects on", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../frontend/app/globals.css", import.meta.url), "utf8");
  assert.ok(css.includes(`[${FULL_SCREEN_ATTRIBUTE}]`));
});
