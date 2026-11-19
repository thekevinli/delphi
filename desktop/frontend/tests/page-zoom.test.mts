import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ZOOM_STEPS, stepPageZoom, pageFrameLayout } from "../app/lib/page-zoom.ts";

test("webpage zoom walks the browser steps in both directions and stops at bounds", () => {
  for (let index = 0; index < PAGE_ZOOM_STEPS.length; index++) {
    assert.equal(stepPageZoom(PAGE_ZOOM_STEPS[index], 1), PAGE_ZOOM_STEPS[Math.min(index + 1, 6)]);
    assert.equal(stepPageZoom(PAGE_ZOOM_STEPS[index], -1), PAGE_ZOOM_STEPS[Math.max(index - 1, 0)]);
  }
});

test("zoom reflows the frame without changing its visible footprint", () => {
  for (const renderWidth of [undefined, 1512]) {
    for (const percent of PAGE_ZOOM_STEPS) {
      const layout = pageFrameLayout(900, 600, renderWidth, percent);
      const scale = Number(layout.transform.slice(6, -1));
      assert.ok(Math.abs(layout.width * scale - 900) < 0.001);
      assert.ok(Math.abs(layout.height * scale - 600) < 0.001);
      assert.equal(layout.width, (renderWidth ?? 900) * 100 / percent);
    }
  }
});
