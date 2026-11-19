import assert from "node:assert/strict";
import test from "node:test";

import { transcriptScroll } from "../app/lib/transcript-scroll.ts";

const view = (over: Partial<Parameters<typeof transcriptScroll>[0]>) => ({
  placed: false, historyLoaded: false, scrollHeight: 600, clientHeight: 600, scrollTop: 0, ...over,
});

test("a long history opens at its latest turn, not at the empty transcript before it", () => {
  // Rendered before history arrives: nothing to place yet, and not placed.
  assert.equal(transcriptScroll(view({})), null);
  // History lands: 20 screens of transcript, still unplaced, so it goes to the end.
  assert.deepEqual(transcriptScroll(view({ historyLoaded: true, scrollHeight: 12000 })), { top: 12000, placed: true });
});

test("returning to a conversation restores where the reader was", () => {
  assert.deepEqual(transcriptScroll(view({ historyLoaded: true, scrollHeight: 12000, saved: 3100 })), { top: 3100, placed: true });
});

test("streaming follows a reader near the end and leaves one reading earlier turns", () => {
  const placed = { placed: true, historyLoaded: true, scrollHeight: 5000, clientHeight: 600 };
  assert.deepEqual(transcriptScroll(view({ ...placed, scrollTop: 4300 })), { top: 5000, placed: true });
  assert.equal(transcriptScroll(view({ ...placed, scrollTop: 1000 })), null);
});
