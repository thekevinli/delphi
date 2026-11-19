import assert from "node:assert/strict";
import test from "node:test";

import { selectionMenuPoint } from "../app/lib/frame-selection.ts";

test("a live page's selection sits on the text, unscaled", () => {
  const point = selectionMenuPoint(
    { left: 100, top: 200, width: 800 },
    800,
    { x: 40, y: 80, w: 120 },
  );
  assert.equal(point.x, 100 + 40 + 60);
  assert.equal(point.y, 200 + 80 - 10);
});

test("a stored DOM's selection is mapped through the iframe scale", () => {
  // 1512px layout photographed into a 756px pane is scale 0.5. A selection
  // 400px down and 200px across in the framed document has to land at 200 / 100
  // in the pane, not at the unscaled 400 / 200 — which is how Reply ended up
  // over a later paragraph on a Notion page.
  const point = selectionMenuPoint(
    { left: 40, top: 80, width: 756 },
    1512,
    { x: 200, y: 400, w: 100 },
  );
  assert.equal(point.x, 40 + (200 + 50) * 0.5);
  assert.equal(point.y, 80 + 400 * 0.5 - 10);
});
