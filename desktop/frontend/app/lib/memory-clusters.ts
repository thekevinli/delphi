/**
 * Domains as regions of the graph.
 *
 * Every page is filed under exactly one domain, so the map can draw each
 * domain as a circle around its pages — but only if the circles do not
 * overlap. A force layout alone never promises that: two domains joined by a
 * handful of links settle into each other, and their circles become one
 * smudge with two labels. So the layout keeps each domain as a rigid group
 * and moves whole groups apart until every circle clears every other.
 *
 * A circle is measured, not guessed: its centre is the members' centroid and
 * its radius reaches the furthest member's edge, plus a margin. Pure and
 * shared, so the worker that settles the layout and the canvas that draws
 * the circles agree exactly on where they are.
 */

export type ClusterCircle = { group: number; x: number; y: number; r: number; size: number };

/** Air inside a circle, between the furthest dot and the dashed line. */
export const CLUSTER_PADDING = 2.4;
/** Air between two circles once they are pushed apart. */
export const CLUSTER_GAP = 5;
/**
 * Above this many domains, pairwise pushing costs too much to run per frame
 * and may not come to rest, so the domains are packed in one pass instead.
 */
export const DENSE_CLUSTERS = 64;

/** Each group's centroid and the radius that encloses its members. */
export function clusterCircles(
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  groups: ArrayLike<number>,
  groupCount: number,
  padding = CLUSTER_PADDING,
): ClusterCircle[] {
  const sumX = new Float64Array(groupCount);
  const sumY = new Float64Array(groupCount);
  const size = new Uint32Array(groupCount);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    sumX[group] += positions[index * 2];
    sumY[group] += positions[index * 2 + 1];
    size[group] += 1;
  }
  const circles: ClusterCircle[] = [];
  for (let group = 0; group < groupCount; group += 1) {
    const count = size[group];
    circles.push({
      group,
      x: count ? sumX[group] / count : 0,
      y: count ? sumY[group] / count : 0,
      r: 0,
      size: count,
    });
  }
  for (let index = 0; index < groups.length; index += 1) {
    const circle = circles[groups[index]];
    const reach =
      Math.hypot(positions[index * 2] - circle.x, positions[index * 2 + 1] - circle.y) +
      radii[index];
    if (reach > circle.r) circle.r = reach;
  }
  for (const circle of circles) if (circle.size) circle.r += padding;
  return circles;
}

/** Above this many pages a domain is left as it settled: its pages already fill its circle, and spreading costs their count squared. */
const SPREAD_LIMIT = 400;

/**
 * Let each domain's pages use the room inside its circle.
 *
 * The circle reaches a domain's furthest page, and the pages a domain shares
 * with its neighbours are pulled out toward them, so the rest settled as a
 * knot in the middle of a mostly empty ring. Here pages nearer each other than
 * an even share of the ring push apart, a little each round, held short of the
 * ring's edge; pages already that far apart do not move, and none is moved
 * further from the ring's centre than both that edge and where it was, so no
 * page leaves its ring and a domain that fills its circle keeps its shape. The
 * centroid may shift as pages spread, so the circle measured afterwards can
 * sit a little off the old one: packing and separation run after this.
 * Deterministic, so a settle lands in the same place every time.
 */
export function spreadClusters(
  positions: Float32Array | number[],
  radii: ArrayLike<number>,
  groups: ArrayLike<number>,
  groupCount: number,
  { rounds = 80, fill = 0.6, margin = 0.14 }: { rounds?: number; fill?: number; margin?: number } = {},
): void {
  const circles = clusterCircles(positions, radii, groups, groupCount);
  const members: number[][] = circles.map(() => []);
  for (let index = 0; index < groups.length; index += 1) members[groups[index]].push(index);
  for (const circle of circles) {
    const list = members[circle.group];
    if (list.length < 3 || list.length > SPREAD_LIMIT) continue;
    const room = (circle.r - CLUSTER_PADDING) * (1 - margin);
    // Hexagonal spacing that would cover `fill` of the ring's area.
    const spacing = 1.9 * Math.sqrt(fill) * room / Math.sqrt(list.length);
    const reach = list.map((index) =>
      Math.max(Math.hypot(positions[index * 2] - circle.x, positions[index * 2 + 1] - circle.y), room - radii[index]));
    for (let round = 0; round < rounds; round += 1) {
      let moved = false;
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j += 1) {
          const b = list[j];
          let dx = positions[b * 2] - positions[a * 2];
          let dy = positions[b * 2 + 1] - positions[a * 2 + 1];
          let distance = Math.hypot(dx, dy);
          if (distance >= spacing) continue;
          const push = (spacing - distance) * 0.12;
          if (distance < 1e-6) {
            // Coincident pages part along a direction fixed by their indices.
            const angle = ((a * 7919 + b * 104729) % 360) * (Math.PI / 180);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          positions[a * 2] -= (dx / distance) * push;
          positions[a * 2 + 1] -= (dy / distance) * push;
          positions[b * 2] += (dx / distance) * push;
          positions[b * 2 + 1] += (dy / distance) * push;
          moved = true;
        }
      }
      list.forEach((index, at) => {
        const dx = positions[index * 2] - circle.x;
        const dy = positions[index * 2 + 1] - circle.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= reach[at]) return;
        positions[index * 2] = circle.x + (dx / distance) * reach[at];
        positions[index * 2 + 1] = circle.y + (dy / distance) * reach[at];
      });
      if (!moved) break;
    }
  }
}

/**
 * Move whole groups apart until no two circles overlap.
 *
 * Rigid moves only — a group is translated, never reshaped — so the layout a
 * domain settled into survives being made room for. Several passes, because
 * clearing one pair can push either circle into a third; the count is fixed
 * so the loop always ends, and the final pass of a settle runs it to rest.
 * Returns whether anything moved.
 */
export function separateClusters(
  positions: Float32Array | number[],
  radii: ArrayLike<number>,
  groups: ArrayLike<number>,
  groupCount: number,
  { gap = CLUSTER_GAP, passes = 6, strength = 1 }: { gap?: number; passes?: number; strength?: number } = {},
): boolean {
  if (groupCount < 2) return false;
  if (groupCount > DENSE_CLUSTERS) return packDense(positions, radii, groups, groupCount, gap);
  let movedAny = false;
  for (let pass = 0; pass < passes; pass += 1) {
    const circles = clusterCircles(positions, radii, groups, groupCount);
    const shiftX = new Float64Array(groupCount);
    const shiftY = new Float64Array(groupCount);
    let moved = false;
    for (let i = 0; i < groupCount; i += 1) {
      const a = circles[i];
      if (!a.size) continue;
      for (let j = i + 1; j < groupCount; j += 1) {
        const b = circles[j];
        if (!b.size) continue;
        const minimum = a.r + b.r + gap;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        if (distance < 1e-6) {
          // Coincident centres have no direction to part along; pick one
          // from the pair's indices so the result is the same every run.
          const angle = ((i * 7919 + j * 104729) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        moved = true;
        const push = (minimum - Math.hypot(b.x - a.x, b.y - a.y)) * strength;
        // The smaller group gives way more, so a large domain holds its place
        // and a two-page one steps aside rather than the reverse.
        const weightA = b.size / (a.size + b.size);
        const weightB = a.size / (a.size + b.size);
        shiftX[i] -= (dx / distance) * push * weightA;
        shiftY[i] -= (dy / distance) * push * weightA;
        shiftX[j] += (dx / distance) * push * weightB;
        shiftY[j] += (dy / distance) * push * weightB;
      }
    }
    if (!moved) break;
    movedAny = true;
    for (let index = 0; index < groups.length; index += 1) {
      positions[index * 2] += shiftX[groups[index]];
      positions[index * 2 + 1] += shiftY[groups[index]];
    }
  }
  if (passes >= 60 && worstClusterOverlap(clusterCircles(positions, radii, groups, groupCount), gap) > 1e-3) {
    return packDense(positions, radii, groups, groupCount, gap);
  }
  return movedAny;
}

/**
 * Draw every domain in until it sits the separation gap from its neighbours.
 *
 * Separation only ever pushes; nothing pulls a domain that no link reaches, so
 * the force layout left one floating far out and the fitted view shrank every
 * dot and name to make room for the empty field between. Here each group
 * steps a fraction of the way toward the circles' area-weighted centre, then
 * `separateClusters` pushes back any overlap, round after round, until the
 * domains rest packed at `gap`. Rigid moves, as there: a domain keeps the
 * shape it settled into. Fixed rounds, so it always ends.
 *
 * Drawn in harder vertically than across, so the packed domains lie wide:
 * both the map and the Dashboard's card are landscape, and a square pile would
 * leave their sides empty. On a real 32-page account 0.08 across and 0.3 down
 * packs to about 1.65:1 at the separation gap.
 */
export function packClusters(
  positions: Float32Array | number[],
  radii: ArrayLike<number>,
  groups: ArrayLike<number>,
  groupCount: number,
  { gap = CLUSTER_GAP, rounds = 40, stepX = 0.08, stepY = 0.3 }: { gap?: number; rounds?: number; stepX?: number; stepY?: number } = {},
): void {
  if (groupCount < 2) return;
  if (groupCount > DENSE_CLUSTERS) { packDense(positions, radii, groups, groupCount, gap); return; }
  for (let round = 0; round < rounds; round += 1) {
    const circles = clusterCircles(positions, radii, groups, groupCount);
    let weight = 0;
    let cx = 0;
    let cy = 0;
    for (const circle of circles) {
      if (!circle.size) continue;
      const area = circle.r * circle.r;
      weight += area;
      cx += circle.x * area;
      cy += circle.y * area;
    }
    if (!weight) return;
    cx /= weight;
    cy /= weight;
    const shiftX = new Float64Array(groupCount);
    const shiftY = new Float64Array(groupCount);
    for (const circle of circles) {
      if (!circle.size) continue;
      shiftX[circle.group] = (cx - circle.x) * stepX;
      shiftY[circle.group] = (cy - circle.y) * stepY;
    }
    for (let index = 0; index < groups.length; index += 1) {
      positions[index * 2] += shiftX[groups[index]];
      positions[index * 2 + 1] += shiftY[groups[index]];
    }
    separateClusters(positions, radii, groups, groupCount, { gap, passes: 12 });
  }
}

/**
 * How hard the packed domains are drawn in across and down. The first is
 * `packClusters`' own, the shape the worker settles into; the rest run from
 * lying wider than that to standing tall. The map picks whichever fills its
 * field best, so the Dashboard's long, low card spreads the domains along
 * its length, and a field made narrow by a docked conversation stacks them,
 * instead of either shrinking the settled pile into the middle.
 */
export const CLUSTER_ARRANGEMENTS: ReadonlyArray<{ stepX: number; stepY: number }> = [
  { stepX: 0.08, stepY: 0.3 },
  { stepX: 0.03, stepY: 0.35 },
  { stepX: 0.05, stepY: 0.32 },
  { stepX: 0.14, stepY: 0.22 },
  { stepX: 0.19, stepY: 0.19 },
  { stepX: 0.22, stepY: 0.14 },
  { stepX: 0.3, stepY: 0.08 },
];

/**
 * `packClusters` and the final `separateClusters`, on the circles alone.
 *
 * Every move there is rigid, so a domain's radius never changes and where its
 * pages end up is its circle's shift applied to each of them. Working on a
 * handful of circles rather than every page is what lets the map rearrange
 * while a divider is being dragged: the cost is the domains squared, not the
 * pages. Returns new circles; the input is left as it was.
 */
export function packCircles(
  circles: ClusterCircle[],
  { gap = CLUSTER_GAP, rounds = 40, stepX = 0.08, stepY = 0.3 }: { gap?: number; rounds?: number; stepX?: number; stepY?: number } = {},
): ClusterCircle[] {
  const packed = circles.map((circle) => ({ ...circle }));
  const live = packed.filter((circle) => circle.size);
  if (live.length < 2) return packed;
  const separate = (passes: number) => {
    for (let pass = 0; pass < passes; pass += 1) {
      const shifts = live.map(() => ({ x: 0, y: 0 }));
      let moved = false;
      for (let i = 0; i < live.length; i += 1) {
        const a = live[i];
        for (let j = i + 1; j < live.length; j += 1) {
          const b = live[j];
          const minimum = a.r + b.r + gap;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= minimum) continue;
          const push = minimum - distance;
          if (distance < 1e-6) {
            const angle = ((a.group * 7919 + b.group * 104729) % 360) * (Math.PI / 180);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          moved = true;
          const weightA = b.size / (a.size + b.size);
          const weightB = a.size / (a.size + b.size);
          shifts[i].x -= (dx / distance) * push * weightA;
          shifts[i].y -= (dy / distance) * push * weightA;
          shifts[j].x += (dx / distance) * push * weightB;
          shifts[j].y += (dy / distance) * push * weightB;
        }
      }
      if (!moved) return;
      live.forEach((circle, index) => {
        circle.x += shifts[index].x;
        circle.y += shifts[index].y;
      });
    }
  };
  for (let round = 0; round < rounds; round += 1) {
    let weight = 0;
    let cx = 0;
    let cy = 0;
    for (const circle of live) {
      const area = circle.r * circle.r;
      weight += area;
      cx += circle.x * area;
      cy += circle.y * area;
    }
    if (!weight) return packed;
    cx /= weight;
    cy /= weight;
    for (const circle of live) {
      circle.x += (cx - circle.x) * stepX;
      circle.y += (cy - circle.y) * stepY;
    }
    separate(12);
  }
  separate(60);
  return packed;
}

export type ClusterArrangements = { settled: ClusterCircle[]; options: Array<ClusterCircle[] | null> };
const arranged = new WeakMap<ArrayLike<number>, ClusterArrangements>();

/**
 * A settled layout's domains, as they lie and packed each of the ways in
 * `CLUSTER_ARRANGEMENTS`. Packing costs the domains squared, so it runs once
 * per layout and a resize only scores what it left. A packing that leaves two
 * domains closer than the gap is not offered.
 */
export function clusterArrangements(
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  groups: ArrayLike<number>,
  groupCount: number,
): ClusterArrangements {
  const known = arranged.get(positions);
  if (known) return known;
  const settled = clusterCircles(positions, radii, groups, groupCount);
  const options = CLUSTER_ARRANGEMENTS.map((steps, index) => {
    if (!index) return settled;
    const packed = packCircles(settled, steps);
    return worstClusterOverlap(packed, CLUSTER_GAP) > 1e-3 ? null : packed;
  });
  const result = { settled, options };
  arranged.set(positions, result);
  return result;
}

/**
 * How large a set of circles can be drawn in a field `aspect` wide for one
 * high: the scale at which their bounding box just fits. Larger is better
 * use of the field.
 */
export function circlesFit(circles: ClusterCircle[], aspect: number): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const circle of circles) {
    if (!circle.size) continue;
    minX = Math.min(minX, circle.x - circle.r); maxX = Math.max(maxX, circle.x + circle.r);
    minY = Math.min(minY, circle.y - circle.r); maxY = Math.max(maxY, circle.y + circle.r);
  }
  if (!(maxX > minX) || !(maxY > minY)) return 0;
  return Math.min(aspect / (maxX - minX), 1 / (maxY - minY));
}

/** The overlap left between any two circles; zero once separation is done. */
export function worstClusterOverlap(circles: ClusterCircle[], gap = 0): number {
  let worst = 0;
  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      const a = circles[i];
      const b = circles[j];
      if (!a.size || !b.size) continue;
      const overlap = a.r + b.r + gap - Math.hypot(b.x - a.x, b.y - a.y);
      if (overlap > worst) worst = overlap;
    }
  }
  return worst;
}

type ChainNode = { circle: ClusterCircle; next: ChainNode; previous: ChainNode };

/** Put `c` against both `a` and `b`, on the outside of the chain. */
function placeTangent(b: ClusterCircle, a: ClusterCircle, c: ClusterCircle): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (!d2) { c.x = a.x + c.r; c.y = a.y; return; }
  const a2 = (a.r + c.r) ** 2;
  const b2 = (b.r + c.r) ** 2;
  if (a2 > b2) {
    const x = (d2 + b2 - a2) / (2 * d2);
    const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
    c.x = b.x - x * dx - y * dy;
    c.y = b.y - x * dy + y * dx;
  } else {
    const x = (d2 + a2 - b2) / (2 * d2);
    const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
    c.x = a.x + x * dx - y * dy;
    c.y = a.y + x * dy + y * dx;
  }
}

function circlesOverlap(a: ClusterCircle, b: ClusterCircle): boolean {
  const reach = a.r + b.r - 1e-6;
  return reach > 0 && reach * reach > (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

/** How far from the origin the gap between a chain node and its successor sits. */
function chainScore(node: ChainNode): number {
  const a = node.circle;
  const b = node.next.circle;
  const ab = a.r + b.r;
  return ((a.x * b.r + b.x * a.r) / ab) ** 2 + ((a.y * b.r + b.y * a.r) / ab) ** 2;
}

/**
 * Circles packed against one another around a front chain, largest first.
 *
 * Every circle is placed tangent to two on the chain, nearest the middle,
 * and the chain is cut back past any it would overlap, so no two ever do
 * (Wang et al., "Visualization of large hierarchical data by circle
 * packing"). One pass, close to linear, and deterministic for a given input:
 * the packing for a set of domains too large to push apart pair by pair.
 * Returns new circles at the input's area-weighted centre, `gap` apart.
 */
export function frontChainPack(circles: ClusterCircle[], gap = CLUSTER_GAP): ClusterCircle[] {
  const packed = circles.map((circle) => ({ ...circle }));
  const live = packed.filter((circle) => circle.size).sort((a, b) => b.r - a.r || a.group - b.group);
  if (!live.length) return packed;
  let weight = 0, cx = 0, cy = 0;
  for (const circle of live) {
    const area = circle.r * circle.r;
    weight += area; cx += circle.x * area; cy += circle.y * area;
  }
  cx /= weight || 1; cy /= weight || 1;
  // Inflated by half the gap, plus a hair for Float32 page positions.
  const pad = gap / 2 + 0.01;
  const work = live.map((circle) => ({ ...circle, r: circle.r + pad, x: 0, y: 0 }));
  if (work.length > 1) {
    work[0].x = -work[1].r;
    work[1].x = work[0].r;
  }
  if (work.length > 2) {
    placeTangent(work[1], work[0], work[2]);
    const first = { circle: work[0] } as ChainNode;
    const second = { circle: work[1] } as ChainNode;
    const third = { circle: work[2] } as ChainNode;
    first.next = third.previous = second;
    second.next = first.previous = third;
    third.next = second.previous = first;
    let a = first;
    let b = second;
    pack: for (let index = 3; index < work.length; index += 1) {
      const c = work[index];
      placeTangent(a.circle, b.circle, c);
      let j = b.next;
      let k = a.previous;
      let sj = b.circle.r;
      let sk = a.circle.r;
      do {
        if (sj <= sk) {
          if (circlesOverlap(j.circle, c)) {
            b = j; a.next = b; b.previous = a; index -= 1;
            continue pack;
          }
          sj += j.circle.r; j = j.next;
        } else {
          if (circlesOverlap(k.circle, c)) {
            a = k; a.next = b; b.previous = a; index -= 1;
            continue pack;
          }
          sk += k.circle.r; k = k.previous;
        }
      } while (j !== k.next);
      const node = { circle: c, previous: a, next: b } as ChainNode;
      a.next = b.previous = node;
      b = node;
      let best = chainScore(a);
      for (let at = node.next; at !== b; at = at.next) {
        const score = chainScore(at);
        if (score < best) { a = at; best = score; }
      }
      b = a.next;
    }
  }
  let px = 0, py = 0;
  for (const circle of work) {
    const area = (circle.r - pad) ** 2;
    px += circle.x * area; py += circle.y * area;
  }
  px /= weight || 1; py /= weight || 1;
  work.forEach((circle, index) => {
    live[index].x = circle.x - px + cx;
    live[index].y = circle.y - py + cy;
  });
  return packed;
}

/** `frontChainPack` applied to the pages: each group moved by its circle's shift. */
function packDense(
  positions: Float32Array | number[], radii: ArrayLike<number>, groups: ArrayLike<number>,
  groupCount: number, gap: number,
): boolean {
  const before = clusterCircles(positions, radii, groups, groupCount);
  const after = frontChainPack(before, gap);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    positions[index * 2] += after[group].x - before[group].x;
    positions[index * 2 + 1] += after[group].y - before[group].y;
  }
  return true;
}
