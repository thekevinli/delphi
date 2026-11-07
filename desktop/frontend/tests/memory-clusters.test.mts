import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLUSTER_ARRANGEMENTS, CLUSTER_GAP, DENSE_CLUSTERS, circlesFit, frontChainPack, clusterArrangements, clusterCircles, packCircles, separateClusters, spreadClusters, worstClusterOverlap, packClusters,
} from "../app/lib/memory-clusters.ts";
import { dailyEditCounts } from "../app/lib/memory.ts";

/** Three domains seeded on top of each other, as a force layout leaves them. */
function piledUp() {
  const groups = [0, 0, 0, 0, 1, 1, 1, 2, 2];
  const positions: number[] = [];
  groups.forEach((group, index) => {
    positions.push(80 + Math.cos(index) * (4 + group), 45 + Math.sin(index) * (3 + group));
  });
  const radii = groups.map((_, index) => 1.4 + (index % 3) * 0.5);
  return { groups, positions: Float32Array.from(positions), radii };
}

test("domain circles end apart, however the layout left them", () => {
  const { groups, positions, radii } = piledUp();
  assert.ok(worstClusterOverlap(clusterCircles(positions, radii, groups, 3)) > 0);
  separateClusters(positions, radii, groups, 3, { passes: 60 });
  const circles = clusterCircles(positions, radii, groups, 3);
  // Clear of each other by the gap, not merely tangent.
  assert.ok(worstClusterOverlap(circles, CLUSTER_GAP) < 1e-3);
});

test("a domain moves as one piece, so its own layout survives", () => {
  const { groups, positions, radii } = piledUp();
  const before = Array.from(positions);
  separateClusters(positions, radii, groups, 3, { passes: 60 });
  // Every pair inside a group keeps its distance: groups are translated,
  // never reshaped.
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      if (groups[i] !== groups[j]) continue;
      const was = Math.hypot(before[i * 2] - before[j * 2], before[i * 2 + 1] - before[j * 2 + 1]);
      const now = Math.hypot(positions[i * 2] - positions[j * 2], positions[i * 2 + 1] - positions[j * 2 + 1]);
      assert.ok(Math.abs(was - now) < 1e-3);
    }
  }
});

test("a circle reaches its furthest page's edge", () => {
  const circles = clusterCircles([0, 0, 10, 0], [1, 2], [0, 0], 1, 0);
  assert.equal(circles[0].x, 5);
  assert.equal(circles[0].r, 7);
});

test("the layout worker keeps domains together and apart", async () => {
  const [worker, canvas] = await Promise.all([
    readFile(new URL("../app/lib/memory-graph.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryGraphCanvas.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /import \{ packClusters, separateClusters, spreadClusters \} from "\.\/memory-clusters"/);
  // Spread within, packed, then settled to rest before the canvas draws a circle around each domain.
  assert.match(worker, /spreadClusters\(positions, radii, groups, groupCount\);\s*packClusters\(positions, radii, groups, groupCount\);\s*separateClusters\(positions, radii, groups, groupCount, \{ passes: 60 \}\)/);
  assert.match(canvas, /groupCount: clusters\.count/);
  assert.match(canvas, /clusterCircles\(positions, clusters\.radii, clusters\.groups, clusters\.count\)/);
});

test("the activity chart has one bar per day, ending today", () => {
  const now = Date.parse("2026-09-30T15:00:00");
  const bars = dailyEditCounts(
    [
      { at: "2026-09-30T10:00:00", edits: [{ slug: "a", title: "A", kind: null, action: "created" }, { slug: "b", title: "B", kind: null, action: "revised" }] },
      { at: "2026-09-26T22:00:00", edits: [] },
      { at: "2026-08-01T10:00:00", edits: [{ slug: "c", title: "C", kind: null, action: "created" }] },
    ],
    14,
    now,
  );
  assert.equal(bars.length, 14);
  assert.equal(bars[13].count, 2);
  // A pass that filed nothing still happened.
  assert.equal(bars[9].count, 1);
  // Older than the window is not drawn.
  assert.equal(bars.reduce((sum, bar) => sum + bar.count, 0), 3);
});

test("packing draws unlinked domains in to the gap, each keeping its shape", () => {
  // Two small domains, 120 units apart with nothing between them.
  const positions = new Float32Array([0, 0, 4, 0, 120, 0, 124, 3]);
  const radii = new Float32Array([1, 1, 1, 1]);
  const groups = new Uint32Array([0, 0, 1, 1]);
  const shape = (i: number, j: number) => [positions[j * 2] - positions[i * 2], positions[j * 2 + 1] - positions[i * 2 + 1]];
  const before = [shape(0, 1), shape(2, 3)];
  packClusters(positions, radii, groups, 2);
  const [a, b] = clusterCircles(positions, radii, groups, 2);
  const gap = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
  assert.ok(gap >= CLUSTER_GAP - 0.01 && gap < CLUSTER_GAP + 1, `gap ${gap}`);
  // Rigid: each domain's own shape is unchanged (within Float32 rounding).
  [shape(0, 1), shape(2, 3)].flat().forEach((value, index) => assert.ok(Math.abs(value - before.flat()[index]) < 1e-3));
});

test("a narrow field stacks the domains instead of shrinking a wide row of them", async () => {
  // Five domains of unequal size, settled the way the worker settles them.
  const sizes = [33, 30, 21, 8, 3];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const count = sizes.reduce((sum, size) => sum + size, 0);
  const positions = new Float32Array(count * 2);
  const radii = new Float32Array(count).fill(0.9);
  const groups = new Uint32Array(count);
  let at = 0;
  sizes.forEach((size, group) => {
    const cx = random() * 80, cy = random() * 80, spread = Math.sqrt(size) * 2.2;
    for (let index = 0; index < size; index += 1, at += 1) {
      const angle = random() * Math.PI * 2, reach = Math.sqrt(random()) * spread;
      positions[at * 2] = cx + Math.cos(angle) * reach;
      positions[at * 2 + 1] = cy + Math.sin(angle) * reach;
      groups[at] = group;
    }
  });
  packClusters(positions, radii, groups, sizes.length);
  separateClusters(positions, radii, groups, sizes.length, { passes: 60 });
  const settled = clusterCircles(positions, radii, groups, sizes.length);
  const options = CLUSTER_ARRANGEMENTS.map((steps) => packCircles(settled, steps));
  // Rigid and clear: every arrangement keeps each radius and leaves no overlap.
  for (const circles of options) {
    circles.forEach((circle, index) => assert.equal(circle.r, settled[index].r));
    assert.ok(worstClusterOverlap(circles, CLUSTER_GAP) < 0.05);
  }
  // The input is not moved.
  assert.deepEqual(settled, clusterCircles(positions, radii, groups, sizes.length));
  const best = (aspect: number) => {
    const scores = options.map((circles) => circlesFit(circles, aspect));
    return { index: scores.indexOf(Math.max(...scores)), scores };
  };
  // The 16:9 map keeps the packing it settled into, and so does a wider map
  // window within the 5% hysteresis. The Dashboard's long, low card, or a map
  // window as long, takes a wider one by more than that; a tall field takes a
  // tall one. Each draws the domains larger than the settle.
  assert.equal(best(16 / 9).index, 0);
  const wide = best(2.2);
  assert.ok(wide.scores[wide.index] <= wide.scores[0] * 1.05, "a wide map window keeps its settle");
  const long = best(2.4);
  assert.ok(long.index === 1 || long.index === 2, `long field chose ${long.index}`);
  assert.ok(long.scores[long.index] > long.scores[0] * 1.05);
  const tall = best(0.6);
  assert.ok(tall.index >= 5, `tall field chose ${tall.index}`);
  assert.ok(tall.scores[tall.index] > tall.scores[0] * 1.2);

  const canvas = await readFile(new URL("../app/components/MemoryGraphCanvas.tsx", import.meta.url), "utf8");
  // The map rearranges on resize from its layout's packings, and refits a fitted view.
  assert.match(canvas, /clusterArrangements\(base,/);
  assert.match(canvas, /fittedRef\.current = true;\s*arrange\(true\);\s*fitView\(\);/);
  assert.match(canvas, /scores\[best\] <= scores\[arrangementRef\.current\] \* 1\.05/);
});

/** Domains of every size, scattered as a force layout leaves them. */
function scattered(count: number) {
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const groups: number[] = [];
  const positions: number[] = [];
  for (let group = 0; group < count; group += 1) {
    const cx = random() * 120, cy = random() * 70, size = 1 + Math.floor(random() * (random() < 0.2 ? 40 : 6));
    for (let index = 0; index < size; index += 1) {
      groups.push(group);
      positions.push(cx + Math.cos(index) * Math.sqrt(index) * 2, cy + Math.sin(index) * Math.sqrt(index) * 2);
    }
  }
  return { positions: Float32Array.from(positions), radii: new Float32Array(groups.length).fill(0.9), groups: Uint32Array.from(groups), count };
}

/** The same domains, settled as the worker settles them. */
function crowded(count: number) {
  const map = scattered(count);
  packClusters(map.positions, map.radii, map.groups, count);
  separateClusters(map.positions, map.radii, map.groups, count, { passes: 60 });
  return map;
}

test("a layout is packed once, however often the field changes shape", () => {
  const { positions, radii, groups, count } = crowded(6);
  const first = clusterArrangements(positions, radii, groups, count);
  assert.equal(first.options.length, CLUSTER_ARRANGEMENTS.length);
  // A resize asks again of the same layout and is handed what was packed.
  assert.equal(clusterArrangements(positions, radii, groups, count), first);
  // A layout the worker settled anew is packed for itself.
  assert.notEqual(clusterArrangements(positions.slice(), radii, groups, count), first);
});

test("a packing that leaves domains overlapping is never offered", () => {
  const { positions, radii, groups, count } = crowded(40);
  const { settled, options } = clusterArrangements(positions, radii, groups, count);
  // The domains as they settled are always there to fall back on.
  assert.equal(options[0], settled);
  // This crowd is one that packing alone cannot always clear.
  assert.ok(CLUSTER_ARRANGEMENTS.slice(1).some((steps) => worstClusterOverlap(packCircles(settled, steps), CLUSTER_GAP) > 1e-3));
  for (const circles of options.slice(1)) {
    if (circles) assert.ok(worstClusterOverlap(circles, CLUSTER_GAP) <= 1e-3);
  }
});

for (const count of [DENSE_CLUSTERS, 100, 200]) {
  test(`a map of ${count} domains settles with none overlapping, quickly`, () => {
    const one = scattered(count);
    const two = scattered(count);
    const started = performance.now();
    packClusters(one.positions, one.radii, one.groups, count);
    separateClusters(one.positions, one.radii, one.groups, count, { passes: 60 });
    const elapsed = performance.now() - started;
    assert.ok(Array.from(one.positions).every(Number.isFinite));
    assert.ok(worstClusterOverlap(clusterCircles(one.positions, one.radii, one.groups, count), CLUSTER_GAP) < 1e-3);
    // Settling runs before the first frame; a dense map skips the pairwise passes that would take long.
    if (count > DENSE_CLUSTERS) assert.ok(elapsed < 400, `${count} domains took ${elapsed.toFixed(0)} ms`);
    packClusters(two.positions, two.radii, two.groups, count);
    separateClusters(two.positions, two.radii, two.groups, count, { passes: 60 });
    assert.deepEqual(one.positions, two.positions);
    // The single nudge each later frame applies leaves them clear too.
    separateClusters(one.positions, one.radii, one.groups, count, { passes: 1, strength: 0.35 });
    assert.ok(worstClusterOverlap(clusterCircles(one.positions, one.radii, one.groups, count), CLUSTER_GAP) < 1e-3);
  });
}

for (const count of [100, 500, 1000]) {
  test(`dense layout separates ${count} coincident domains deterministically`, () => {
    const groups = Array.from({ length: count }, (_, i) => i);
    const radii = groups.map(i => 1 + (i % 13));
    const one = new Float32Array(count * 2);
    const two = one.slice();
    for (const positions of [one, two]) {
      packClusters(positions, radii, groups, count);
      separateClusters(positions, radii, groups, count, { passes: 60 });
      assert.ok(Array.from(positions).every(Number.isFinite));
      assert.ok(worstClusterOverlap(clusterCircles(positions, radii, groups, count), CLUSTER_GAP) < 1e-3);
    }
    assert.deepEqual(one, two);
    // Packed as circles around a middle, never laid out in rows: the box
    // around them stays close to square.
    const circles = clusterCircles(one, radii, groups, count);
    const xs = circles.flatMap((c) => [c.x - c.r, c.x + c.r]);
    const ys = circles.flatMap((c) => [c.y - c.r, c.y + c.r]);
    const ratio = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
    assert.ok(ratio > 0.7 && ratio < 1.4, `ratio ${ratio}`);
  });
}

test("a dense packing keeps every domain whole and the map where it was", () => {
  const { positions, radii, groups, count } = scattered(200);
  const before = clusterCircles(positions, radii, groups, count);
  const after = frontChainPack(before);
  after.forEach((circle, index) => assert.equal(circle.r, before[index].r));
  assert.ok(worstClusterOverlap(after, CLUSTER_GAP) < 1e-3);
  const centre = (circles: typeof before) => {
    let weight = 0, x = 0, y = 0;
    for (const c of circles) if (c.size) { weight += c.r * c.r; x += c.x * c.r * c.r; y += c.y * c.r * c.r; }
    return [x / weight, y / weight];
  };
  const [bx, by] = centre(before);
  const [ax, ay] = centre(after);
  assert.ok(Math.hypot(ax - bx, ay - by) < 1e-6);
});

/** The closest two pages of `group`. */
function nearestPair(positions: ArrayLike<number>, groups: number[], group: number): number {
  let nearest = Infinity;
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      if (groups[i] !== group || groups[j] !== group) continue;
      nearest = Math.min(nearest, Math.hypot(positions[i * 2] - positions[j * 2], positions[i * 2 + 1] - positions[j * 2 + 1]));
    }
  }
  return nearest;
}

test("a domain's knot spreads into its circle's room, and no page leaves the circle", () => {
  // Eight pages knotted at the middle and one pulled far out by a link to
  // another domain: the circle is the outlier's, the room inside it unused.
  const groups = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  const positions: number[] = [];
  for (let index = 0; index < 8; index += 1) positions.push(50 + Math.cos(index) * 1.2, 50 + Math.sin(index) * 1.2);
  positions.push(78, 50, 140, 50, 142, 52, 140, 54);
  const radii = groups.map(() => 1.6);
  const [before] = clusterCircles(positions, radii, groups, 2);
  const otherBefore = positions.slice(18);
  const knot = nearestPair(positions, groups, 0);
  spreadClusters(positions, radii, groups, 2);
  assert.ok(nearestPair(positions, groups, 0) > knot * 3, "the knot loosens");
  for (let index = 0; index < 9; index += 1) {
    const reach = Math.hypot(positions[index * 2] - before.x, positions[index * 2 + 1] - before.y) + radii[index];
    assert.ok(reach <= before.r + 1e-3, `page ${index} stays inside its circle`);
  }
  // A domain of three already apart from one another keeps its shape.
  assert.deepEqual(positions.slice(18), otherBefore);
});

test("spreading is deterministic", () => {
  const { groups, positions, radii } = piledUp();
  const again = Float32Array.from(positions);
  spreadClusters(positions, radii, groups, 3);
  spreadClusters(again, radii, groups, 3);
  assert.deepEqual(Array.from(positions), Array.from(again));
});
