import assert from "node:assert/strict";
import test from "node:test";
import { pageZoomDirection, pageZoomScript } from "../main/page-zoom.ts";

test("Cmd plus/minus routes layout zoom without intercepting pinch or ordinary typing", () => {
  const input = { type: "keyDown", key: "+", meta: true, control: false, alt: false };
  assert.equal(pageZoomDirection(input), 1);
  assert.equal(pageZoomDirection({ ...input, key: "=" }), 1);
  assert.equal(pageZoomDirection({ ...input, key: "-" }), -1);
  assert.equal(pageZoomDirection({ ...input, key: "0" }), 0);
  assert.equal(pageZoomDirection({ ...input, meta: false }), null);
  assert.equal(pageZoomDirection({ ...input, type: "keyUp" }), null);
  assert.equal(pageZoomDirection({ ...input, control: true }), null);
  assert.equal(pageZoomDirection({ ...input, key: "a" }), null);
});

test("desktop zoom emits only a directional reader event", () => {
  for (const direction of [-1, 0, 1]) {
    let event: unknown;
    new Function("window", "CustomEvent", pageZoomScript(direction))(
      { dispatchEvent(value: unknown) { event = value; } },
      class {
        type: string;
        options: unknown;
        constructor(type: string, options: unknown) { this.type = type; this.options = options; }
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(event)), { type: "delphi-page-zoom", options: { detail: direction } });
  }
});
