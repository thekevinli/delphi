import assert from "node:assert/strict";
import test from "node:test";

import {
  bandsIntersect,
  clampBandsToText,
  mergeIntoLineBands,
  type Rect,
} from "../app/lib/highlight-rects.ts";

/** A run of pdf.js spans on one line: same top, same height, laid end to end. */
const spansOnLine = (top: number, height: number, from: number, count: number): Rect[] =>
  Array.from({ length: count }, (_, index) => ({
    x: from + index * 0.06,
    y: top,
    w: 0.06,
    h: height,
  }));

const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-9 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-9;

test("a line arrives as a dozen spans and leaves as one stroke", () => {
  const bands = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.1, 12));
  assert.equal(bands.length, 1);
  assert.ok(Math.abs(bands[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(bands[0].w - 0.72) < 1e-9);
});

test("consecutive lines stay separate strokes", () => {
  const bands = mergeIntoLineBands([
    ...spansOnLine(0.2, 0.012, 0.1, 6),
    ...spansOnLine(0.216, 0.012, 0.1, 6),
    ...spansOnLine(0.232, 0.012, 0.1, 4),
  ]);
  assert.equal(bands.length, 3);
  assert.deepEqual(
    bands.map((band) => Number(band.y.toFixed(3))),
    [0.2, 0.216, 0.232],
  );
});

test("a superscript is absorbed into its line rather than becoming a stripe", () => {
  // The marker sits above the baseline and is half the height of body text, so
  // it must not start a line of its own — but the stroke does have to cover it.
  const bands = mergeIntoLineBands([
    ...spansOnLine(0.2, 0.012, 0.1, 4),
    { x: 0.34, y: 0.196, w: 0.006, h: 0.006 },
    ...spansOnLine(0.2, 0.012, 0.35, 3),
  ]);
  assert.equal(bands.length, 1);
  assert.ok(bands[0].y <= 0.196, "the band reaches the superscript");
  assert.ok(bands[0].y + bands[0].h >= 0.212, "and still covers the body text");
});

test("a display equation's tall brackets are part of the same stroke", () => {
  // The case LaTeX gets wrong today: brackets, limits and body all belong to one
  // line, so clipping to body-text height would leave the tall glyphs unpainted.
  const bands = mergeIntoLineBands([
    { x: 0.12, y: 0.3, w: 0.01, h: 0.05 },
    ...spansOnLine(0.318, 0.014, 0.14, 8),
    { x: 0.2, y: 0.34, w: 0.02, h: 0.008 },
    { x: 0.63, y: 0.3, w: 0.01, h: 0.05 },
  ]);
  assert.equal(bands.length, 1);
  assert.ok(Math.abs(bands[0].y - 0.3) < 1e-9);
  assert.ok(Math.abs(bands[0].h - 0.05) < 1e-9);
});

test("a two-column gutter is not bridged into one bar across the page", () => {
  const bands = mergeIntoLineBands([
    ...spansOnLine(0.4, 0.012, 0.08, 5),
    ...spansOnLine(0.4, 0.012, 0.55, 5),
  ]);
  assert.equal(bands.length, 2);
  assert.ok(bands[0].x + bands[0].w < bands[1].x);
});

test("no two bands ever overlap, which is what stops the colour doubling", () => {
  const bands = mergeIntoLineBands([
    // Overlapping duplicates of the same word, as a re-entered selection produces.
    { x: 0.1, y: 0.2, w: 0.1, h: 0.012 },
    { x: 0.14, y: 0.2005, w: 0.1, h: 0.0125 },
    // A bracket tall enough to reach into the line below.
    { x: 0.3, y: 0.198, w: 0.008, h: 0.03 },
    ...spansOnLine(0.216, 0.012, 0.1, 5),
  ]);
  for (let i = 0; i < bands.length; i += 1) {
    for (let j = i + 1; j < bands.length; j += 1) {
      assert.ok(!overlaps(bands[i], bands[j]), `bands ${i} and ${j} overlap`);
    }
  }
});

test("merging is idempotent, because stored highlights are merged again on paint", () => {
  const once = mergeIntoLineBands([
    ...spansOnLine(0.2, 0.012, 0.1, 7),
    ...spansOnLine(0.216, 0.012, 0.1, 3),
    { x: 0.3, y: 0.198, w: 0.008, h: 0.03 },
  ]);
  assert.deepEqual(mergeIntoLineBands(once), once);
});

test("every band is a legal PdfRect", () => {
  // The API bounds x and y to 0..1 and requires w and h strictly above zero, so
  // a band that escaped the page would be answered with a 422.
  const bands = mergeIntoLineBands([
    { x: -0.2, y: 0.5, w: 0.4, h: 0.012 },
    { x: 0.9, y: 0.5, w: 0.5, h: 0.012 },
    { x: 0.3, y: 0.99, w: 0.2, h: 0.4 },
  ]);
  for (const band of bands) {
    assert.ok(band.x >= 0 && band.x <= 1);
    assert.ok(band.y >= 0 && band.y <= 1);
    assert.ok(band.w > 0 && band.x + band.w <= 1 + 1e-9);
    assert.ok(band.h > 0 && band.y + band.h <= 1 + 1e-9);
  }
});

test("noise and empty selections survive without inventing a band", () => {
  assert.deepEqual(mergeIntoLineBands([]), []);
  assert.deepEqual(mergeIntoLineBands([{ x: 0.1, y: 0.1, w: 0, h: 0.01 }]), []);
});


/** Three lines of glyph boxes, the shape a rendered text layer reports. */
const textLines: Rect[] = [
  ...spansOnLine(0.2, 0.012, 0.1, 8),
  ...spansOnLine(0.216, 0.012, 0.1, 8),
  ...spansOnLine(0.232, 0.012, 0.1, 8),
];

test("a band that is too tall is trimmed to the line it actually covers", () => {
  // The failure this exists for: a stored rect fractionally taller than its
  // line paints over the text below it, which reads as a highlight on words the
  // reader never selected.
  const [band] = clampBandsToText(
    [{ x: 0.1, y: 0.199, w: 0.48, h: 0.021 }],
    textLines,
  );
  assert.ok(Math.abs(band.y - 0.2) < 1e-9);
  assert.ok(Math.abs(band.h - 0.012) < 1e-9, `height was ${band.h}`);
  assert.ok(band.y + band.h <= 0.216 + 1e-9, "does not reach the next line");
});

test("a band that already fits its line is left exactly alone", () => {
  const band = { x: 0.1, y: 0.2, w: 0.48, h: 0.012 };
  assert.deepEqual(clampBandsToText([band], textLines), [band]);
});

test("a tall equation keeps its height, because its glyphs are spans too", () => {
  const equation: Rect[] = [
    { x: 0.12, y: 0.3, w: 0.01, h: 0.05 },
    ...spansOnLine(0.318, 0.014, 0.14, 6),
  ];
  const [band] = clampBandsToText([{ x: 0.1, y: 0.3, w: 0.5, h: 0.05 }], equation);
  assert.ok(Math.abs(band.h - 0.05) < 1e-9);
});

test("with no text layer yet, a band is left as it is rather than guessed at", () => {
  const band = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 };
  assert.deepEqual(clampBandsToText([band], []), [band]);
});

test("a band over blank space keeps its own extent", () => {
  // Nothing to trim against, so trimming to nothing would erase the highlight.
  const band = { x: 0.1, y: 0.8, w: 0.4, h: 0.012 };
  assert.deepEqual(clampBandsToText([band], textLines), [band]);
});

test("a word and the sentence around it merge into one stroke", () => {
  // The reader marked one word, then the whole line. That is one mark, not two
  // records stacked over the same words — stacked, they doubled the colour and
  // met at a visible seam mid-sentence.
  const word = spansOnLine(0.2, 0.012, 0.3, 2);
  const sentence = spansOnLine(0.2, 0.012, 0.1, 12);
  assert.equal(bandsIntersect(mergeIntoLineBands(sentence), mergeIntoLineBands(word)), true);

  const merged = mergeIntoLineBands([...word, ...sentence]);
  assert.equal(merged.length, 1);
  assert.ok(Math.abs(merged[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(merged[0].w - 0.72) < 1e-9);
});

test("the same words highlighted twice merge back to the same stroke", () => {
  const once = spansOnLine(0.2, 0.012, 0.1, 6);
  assert.deepEqual(mergeIntoLineBands([...once, ...once]), mergeIntoLineBands(once));
});

test("marks that only meet at their edges are still one stroke", () => {
  // Two halves of a sentence, highlighted in two goes. A hair of a gap between
  // them is a rounding difference, not a space the reader left on purpose.
  const left = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.1, 4));
  const right = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.341, 4));
  assert.equal(bandsIntersect(left, right), true);
});

test("a mark on the line below is not absorbed into the one above", () => {
  const above = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.1, 6));
  const below = mergeIntoLineBands(spansOnLine(0.22, 0.012, 0.1, 6));
  assert.equal(bandsIntersect(below, above), false);
});

test("a mark further along the same line stays its own stroke", () => {
  const start = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.1, 3));
  const later = mergeIntoLineBands(spansOnLine(0.2, 0.012, 0.6, 3));
  assert.equal(bandsIntersect(start, later), false);
});
