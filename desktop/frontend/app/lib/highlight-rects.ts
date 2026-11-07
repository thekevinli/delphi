/**
 * Turning a browser text selection into something that looks like a highlighter.
 *
 * `Range.getClientRects()` hands back one box per text-layer span crossed, and
 * pdf.js splits a single visual line into a dozen absolutely-positioned spans
 * whose tops and heights differ by a fraction of a pixel. Painted verbatim, that
 * is the sawtooth edge every PDF reader has — and because each box is its own
 * `mix-blend-mode: multiply` layer, wherever two of them overlap the colour
 * doubles and the reader sees a darker patch mid-word.
 *
 * A person with a marker draws one stroke per line. So does this: cluster the
 * boxes into lines, take each line's full vertical extent, and union the boxes
 * horizontally into as few runs as the line actually has. The guaranteed
 * post-condition is that no two output rects overlap, which is what removes the
 * double-darkening; the smooth edge falls out of using one band per line.
 *
 * Two things the naive version gets wrong and this does not. Mathematics is the
 * reason the band is the *union* of a line rather than its dominant text height:
 * a display equation's brackets, superscripts and summation limits are all
 * legitimately part of one stroke, and clipping them to body-text height leaves
 * the tall glyphs unpainted. A two-column page is the reason horizontal runs are
 * not simply min-x to max-x: the gutter between columns must not be bridged into
 * one bar across the page.
 *
 * No vertical padding is applied here, deliberately. A marker overshoots its
 * glyphs slightly, but that is a rendering flourish and belongs in CSS — adding
 * it to the geometry would make the function non-idempotent, and it is run again
 * over already-merged rects every time a stored highlight is painted.
 *
 * Kept JSX-free and dependency-free so `node --test` can strip the types and run
 * it directly.
 */

/** A page-normalised rectangle: `x`/`w` are fractions of page width, `y`/`h` of height. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Below this a rect is measurement noise, and the API would reject it anyway —
 * The backend rectangle contract requires positive width and height.
 */
const EPSILON = 1e-5;

/**
 * A box joins the line it already overlaps by more than half of *its own* height.
 * Using the box's own height as the denominator is what lets a superscript — tiny,
 * and sitting above the baseline — attach to the line it belongs to, while the
 * first box of the next line, which barely grazes the one above, starts a new one.
 */
const LINE_OVERLAP = 0.5;

/**
 * A box whose height is outside this band of the selection's median is not body
 * text: a bracket spanning a fraction, a subscript, an inline radical. Those are
 * held back from forming lines of their own and attached afterwards, so one tall
 * glyph cannot stretch a line's extent far enough to swallow the line below it.
 */
const CORE_MIN = 0.6;
const CORE_MAX = 1.6;

/**
 * How far apart two runs on one line may be before they stay separate, as a
 * multiple of the line's height. Generous enough for the space around a display
 * equation's operators, far short of the gutter between two columns of text.
 */
const RUN_GAP = 0.75;

/** Letter and A4 are both near enough to this; only used when a caller omits it. */
const DEFAULT_PAGE_ASPECT = 8.5 / 11;

type Line = { top: number; bottom: number; members: Rect[] };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const overlap = (aTop: number, aBottom: number, bTop: number, bBottom: number) =>
  Math.min(aBottom, bBottom) - Math.max(aTop, bTop);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Collapse a selection's client rects into one band per line of text.
 *
 * `pageAspect` is page width over page height. It is needed because `x` and `y`
 * are normalised against different dimensions, so a gap measured in height units
 * cannot be compared to one measured in width units without it. Callers that
 * know the page box should pass it; the default is close enough for paper sizes.
 */
export function mergeIntoLineBands(
  rects: readonly Rect[],
  pageAspect: number = DEFAULT_PAGE_ASPECT,
): Rect[] {
  const usable = rects.filter(
    (rect) =>
      Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      rect.w > EPSILON &&
      rect.h > EPSILON,
  );
  if (usable.length < 2) return usable.map(normalise);

  const aspect = pageAspect > 0 && Number.isFinite(pageAspect) ? pageAspect : DEFAULT_PAGE_ASPECT;
  const typical = median(usable.map((rect) => rect.h));

  // Body text first. Outliers join a line rather than defining one.
  const core = usable.filter(
    (rect) => rect.h >= typical * CORE_MIN && rect.h <= typical * CORE_MAX,
  );
  const seeds = core.length ? core : usable;
  const isCore = new Set(seeds);
  const outliers = usable.filter((rect) => !isCore.has(rect));

  const lines: Line[] = [];
  for (const rect of [...seeds].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const bottom = rect.y + rect.h;
    const current = lines[lines.length - 1];
    if (current && overlap(rect.y, bottom, current.top, current.bottom) > rect.h * LINE_OVERLAP) {
      current.top = Math.min(current.top, rect.y);
      current.bottom = Math.max(current.bottom, bottom);
      current.members.push(rect);
      continue;
    }
    lines.push({ top: rect.y, bottom, members: [rect] });
  }

  // A bracket or a subscript belongs to whichever line it overlaps most. One that
  // overlaps nothing — a lone display equation among prose — becomes its own line.
  for (const rect of outliers) {
    const bottom = rect.y + rect.h;
    let best: Line | null = null;
    let bestOverlap = 0;
    for (const line of lines) {
      const shared = overlap(rect.y, bottom, line.top, line.bottom);
      if (shared > bestOverlap) {
        best = line;
        bestOverlap = shared;
      }
    }
    if (best) {
      best.top = Math.min(best.top, rect.y);
      best.bottom = Math.max(best.bottom, bottom);
      best.members.push(rect);
    } else {
      lines.push({ top: rect.y, bottom, members: [rect] });
    }
  }

  const bands: Rect[] = [];
  for (const line of lines) {
    const height = line.bottom - line.top;
    // Compared in width units, because that is what `x` is normalised against.
    const tolerance = (height * RUN_GAP) / aspect;
    const ordered = [...line.members].sort((a, b) => a.x - b.x);
    let left = ordered[0].x;
    let right = ordered[0].x + ordered[0].w;
    for (const rect of ordered.slice(1)) {
      if (rect.x <= right + tolerance) {
        right = Math.max(right, rect.x + rect.w);
        continue;
      }
      bands.push(normalise({ x: left, y: line.top, w: right - left, h: height }));
      left = rect.x;
      right = rect.x + rect.w;
    }
    bands.push(normalise({ x: left, y: line.top, w: right - left, h: height }));
  }

  return separate(bands)
    .filter((band) => band.w > EPSILON && band.h > EPSILON)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The last word on the no-overlap post-condition.
 *
 * A tall glyph attaches to the line it overlaps most, which can stretch that
 * line's extent into the one above or below — so two bands can still collide even
 * though every box was assigned exactly once. Two bands cannot paint the same
 * pixels without doubling the colour, so where they meet they split the
 * difference. This is also what makes the whole function idempotent: run it over
 * its own output and no band overlaps another, so every band is its own line and
 * comes back unchanged.
 */
function separate(bands: Rect[]): Rect[] {
  const ordered = [...bands].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const above = ordered[i];
      const below = ordered[j];
      const shared = overlap(above.y, above.y + above.h, below.y, below.y + below.h);
      if (shared <= 0) continue;
      const sideways = Math.min(above.x + above.w, below.x + below.w) - Math.max(above.x, below.x);
      if (sideways <= 0) continue;
      const seam = Math.max(above.y, below.y) + shared / 2;
      ordered[i] = { ...above, h: Math.max(0, seam - above.y) };
      ordered[j] = { ...below, y: Math.max(below.y, seam), h: Math.max(0, below.y + below.h - seam) };
    }
  }
  return ordered;
}

/**
 * Trim bands to the text they actually cover.
 *
 * Merging bounds a band by the glyph boxes it was built from, which is enough
 * for anything captured from a live selection. It is not enough for a band that
 * arrives from somewhere else — a record written by an older client, a rect
 * seeded by hand — and a band even slightly too tall bleeds into the line below
 * and reads as a highlight over text the reader never selected.
 *
 * So the page's own text layer gets the last word: a band keeps only the
 * vertical extent of the spans it overlaps horizontally and already covers the
 * middle of. Nothing is widened, only trimmed, so a correct band is unchanged
 * and an equation still keeps its full height — its tall glyphs are spans too.
 * With no spans to check against (the text layer has not rendered yet) the band
 * is left exactly as it was rather than guessed at.
 */
export function clampBandsToText(bands: readonly Rect[], spans: readonly Rect[]): Rect[] {
  if (!spans.length) return [...bands];
  const trimmed: Rect[] = [];
  for (const band of bands) {
    const bottom = band.y + band.h;
    let top = Infinity;
    let floor = -Infinity;
    for (const span of spans) {
      const spanBottom = span.y + span.h;
      const middle = span.y + span.h / 2;
      // Covered vertically by this band, and actually beneath it horizontally.
      if (middle < band.y || middle > bottom) continue;
      if (Math.min(span.x + span.w, band.x + band.w) - Math.max(span.x, band.x) <= 0) {
        continue;
      }
      top = Math.min(top, span.y);
      floor = Math.max(floor, spanBottom);
    }
    if (!Number.isFinite(top) || !Number.isFinite(floor) || floor <= top) {
      trimmed.push(band);
      continue;
    }
    // A band already inside its text is returned as-is rather than recomputed:
    // subtracting two coordinates to arrive back at the same height introduces
    // float drift into a value that never needed to change.
    if (band.y >= top - EPSILON && bottom <= floor + EPSILON) {
      trimmed.push(band);
      continue;
    }
    trimmed.push(
      normalise({
        x: band.x,
        y: Math.max(band.y, top),
        w: band.w,
        h: Math.min(bottom, floor) - Math.max(band.y, top),
      }),
    );
  }
  return trimmed.filter((band) => band.w > EPSILON && band.h > EPSILON);
}

/**
 * Do two sets of bands mark the same run of text?
 *
 * The question a reader asks by highlighting a phrase inside one they marked
 * before: is this the same stroke, or another one? Where the answer is yes the
 * two records become one, so this only ever has to be a predicate — the
 * geometry of the merged stroke is `mergeIntoLineBands` over both sets of
 * rects, which is the same function that made each of them in the first place.
 *
 * Touching counts, not just overlapping. Two marks that meet at a hair's
 * breadth are one stroke to anyone reading the page, and treating them as two
 * is exactly the visible seam mid-sentence this is here to remove.
 */
export function bandsIntersect(
  bands: readonly Rect[],
  others: readonly Rect[],
): boolean {
  return bands.some((band) =>
    others.some((other) => {
      const shared = overlap(band.y, band.y + band.h, other.y, other.y + other.h);
      // The same line, by the same test that built the lines in the first place.
      if (shared <= Math.min(band.h, other.h) * LINE_OVERLAP) return false;
      const gap =
        Math.max(band.x, other.x) - Math.min(band.x + band.w, other.x + other.w);
      return gap < TOUCHING;
    }),
  );
}

/** A gap narrower than this is a rounding difference, not a space between marks. */
const TOUCHING = 0.004;

function normalise(rect: Rect): Rect {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  return {
    x,
    y,
    w: clamp01(Math.min(rect.w, 1 - x)),
    h: clamp01(Math.min(rect.h, 1 - y)),
  };
}
