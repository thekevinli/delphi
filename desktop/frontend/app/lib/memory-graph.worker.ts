/// <reference lib="webworker" />

import { packClusters, separateClusters, spreadClusters } from "./memory-clusters";

/** Worker-only force simulation for the 1,000-page graph. */
type LayoutRequest = {
  type: "layout";
  key: string;
  positions: ArrayBuffer;
  radii: ArrayBuffer;
  edges: ArrayBuffer;
  /**
   * Each node's domain, as an index into `groupCount` domains. A page is
   * filed under exactly one domain, so the layout keeps each domain together
   * and moves whole domains apart until their circles no longer overlap.
   */
  groups: ArrayBuffer;
  groupCount: number;
  reducedMotion: boolean;
  /**
   * Whether to spread the settling over wall-clock time so a reader can watch
   * it happen. False runs the whole simulation in one task and posts only the
   * result — what a cached layout and a reduced-motion reader both want.
   */
  animate: boolean;
};

/** How long a visible settle should take, and how often it repaints. */
const SETTLE_MS = 900;
const FRAME_MS = 16;

type Quad = {
  x0: number; y0: number; x1: number; y1: number;
  mass: number; cx: number; cy: number; point: number;
  children: Array<Quad | null> | null;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

function childFor(quad: Quad, x: number, y: number): number {
  const mx = (quad.x0 + quad.x1) / 2;
  const my = (quad.y0 + quad.y1) / 2;
  return (y >= my ? 2 : 0) + (x >= mx ? 1 : 0);
}

function split(quad: Quad): void {
  const mx = (quad.x0 + quad.x1) / 2;
  const my = (quad.y0 + quad.y1) / 2;
  quad.children = [
    { x0: quad.x0, y0: quad.y0, x1: mx, y1: my, mass: 0, cx: 0, cy: 0, point: -1, children: null },
    { x0: mx, y0: quad.y0, x1: quad.x1, y1: my, mass: 0, cx: 0, cy: 0, point: -1, children: null },
    { x0: quad.x0, y0: my, x1: mx, y1: quad.y1, mass: 0, cx: 0, cy: 0, point: -1, children: null },
    { x0: mx, y0: my, x1: quad.x1, y1: quad.y1, mass: 0, cx: 0, cy: 0, point: -1, children: null },
  ];
}

function insert(quad: Quad, point: number, positions: Float32Array, depth = 0): void {
  const x = positions[point * 2];
  const y = positions[point * 2 + 1];
  if (quad.children) {
    insert(quad.children[childFor(quad, x, y)]!, point, positions, depth + 1);
    return;
  }
  if (quad.point < 0) {
    quad.point = point;
    return;
  }
  // Float32 seeds can coincide. A depth cap keeps that harmless and
  // deterministic rather than recursively subdividing a zero-sized cell.
  if (depth > 24) return;
  const held = quad.point;
  quad.point = -1;
  split(quad);
  insert(quad.children![childFor(quad, positions[held * 2], positions[held * 2 + 1])]!, held, positions, depth + 1);
  insert(quad.children![childFor(quad, x, y)]!, point, positions, depth + 1);
}

function accumulate(quad: Quad, positions: Float32Array): void {
  if (!quad.children) {
    if (quad.point >= 0) {
      quad.mass = 1;
      quad.cx = positions[quad.point * 2];
      quad.cy = positions[quad.point * 2 + 1];
    }
    return;
  }
  let mass = 0;
  let x = 0;
  let y = 0;
  for (const child of quad.children) {
    if (!child) continue;
    accumulate(child, positions);
    mass += child.mass;
    x += child.cx * child.mass;
    y += child.cy * child.mass;
  }
  quad.mass = mass;
  if (mass) {
    quad.cx = x / mass;
    quad.cy = y / mass;
  }
}

function tree(positions: Float32Array): Quad {
  // Bounded by the nodes rather than by the 160×90 field: domains are pushed
  // apart as whole groups, so the layout may be wider than the field, and the
  // view is fitted to it afterwards instead.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let index = 0; index < positions.length; index += 2) {
    x0 = Math.min(x0, positions[index]); x1 = Math.max(x1, positions[index]);
    y0 = Math.min(y0, positions[index + 1]); y1 = Math.max(y1, positions[index + 1]);
  }
  const side = Math.max(1, x1 - x0, y1 - y0) + 2;
  const root: Quad = { x0: x0 - 1, y0: y0 - 1, x1: x0 - 1 + side, y1: y0 - 1 + side, mass: 0, cx: 0, cy: 0, point: -1, children: null };
  for (let index = 0; index < positions.length / 2; index += 1) insert(root, index, positions);
  accumulate(root, positions);
  return root;
}

function repel(index: number, quad: Quad, positions: Float32Array, velocity: Float32Array, alpha: number): void {
  if (!quad.mass) return;
  const x = positions[index * 2];
  const y = positions[index * 2 + 1];
  const dx = x - quad.cx;
  const dy = y - quad.cy;
  const distance2 = dx * dx + dy * dy + 0.01;
  const width = quad.x1 - quad.x0;
  if (!quad.children || (width * width) / distance2 < 0.72) {
    if (quad.point === index && quad.mass === 1) return;
    const force = (0.105 * alpha * quad.mass) / distance2;
    velocity[index * 2] += dx * force;
    velocity[index * 2 + 1] += dy * force;
    return;
  }
  for (const child of quad.children) if (child) repel(index, child, positions, velocity, alpha);
}

function collide(index: number, quad: Quad, positions: Float32Array, radii: Float32Array, velocity: Float32Array): void {
  if (!quad.mass) return;
  const x = positions[index * 2];
  const y = positions[index * 2 + 1];
  const reach = radii[index] + 1.5;
  if (quad.x0 > x + reach || quad.x1 < x - reach || quad.y0 > y + reach || quad.y1 < y - reach) return;
  if (!quad.children) {
    const other = quad.point;
    if (other < 0 || other <= index) return;
    let dx = positions[other * 2] - x;
    const dy = positions[other * 2 + 1] - y;
    if (!dx && !dy) dx = ((index * 1103515245) & 1) ? 0.001 : -0.001;
    const distance = Math.max(0.001, Math.hypot(dx, dy));
    const wanted = radii[index] + radii[other] + 0.7;
    if (distance >= wanted) return;
    const push = ((wanted - distance) / distance) * 0.18;
    velocity[index * 2] -= dx * push;
    velocity[index * 2 + 1] -= dy * push;
    velocity[other * 2] += dx * push;
    velocity[other * 2 + 1] += dy * push;
    return;
  }
  for (const child of quad.children) if (child) collide(index, child, positions, radii, velocity);
}

scope.onmessage = (event: MessageEvent<LayoutRequest>) => {
  if (event.data.type !== "layout") return;
  const positions = new Float32Array(event.data.positions);
  const radii = new Float32Array(event.data.radii);
  const edges = new Uint32Array(event.data.edges);
  const groups = new Uint32Array(event.data.groups);
  const groupCount = event.data.groupCount;
  const velocity = new Float32Array(positions.length);
  const sumX = new Float64Array(groupCount);
  const sumY = new Float64Array(groupCount);
  const size = new Uint32Array(groupCount);
  const iterations = 180;
  // Paced by the clock, in chunks, rather than throttled inside one
  // uninterrupted loop. The throttle was `performance.now() - lastPosted >= 50`
  // measured *while the loop ran*, and on a real 94-page account the whole
  // simulation finished inside a single 50ms window — so it posted no
  // intermediate frame at all, and the graph appeared fully formed. Even where
  // the gate did fire, every frame was posted from the same synchronous task,
  // so they arrived in one burst and painted once. Making the settle visible
  // means the simulation has to *take* time, not merely report on itself.
  const chunk = Math.max(1, Math.ceil(iterations / (SETTLE_MS / FRAME_MS)));
  const startedAt = performance.now();
  let step = 0;

  const advance = (): void => {
    const until = Math.min(iterations, step + (event.data.animate ? chunk : iterations));
    while (step < until) {
      run();
      step += 1;
    }
    if (step >= iterations) {
      // To rest: domains are drawn in to the separation gap, so one that no
      // link reaches does not float off and shrink the fitted map; then any
      // overlap left is cleared outright, so the circles the canvas draws
      // around each domain never intersect. Each domain's pages first spread
      // into the room its circle already has.
      spreadClusters(positions, radii, groups, groupCount);
      packClusters(positions, radii, groups, groupCount);
      separateClusters(positions, radii, groups, groupCount, { passes: 60 });
      scope.postMessage(
        { type: "settled", key: event.data.key, positions: positions.buffer },
        [positions.buffer],
      );
      return;
    }
    const frame = positions.slice();
    scope.postMessage({ type: "frame", key: event.data.key, positions: frame.buffer }, [
      frame.buffer,
    ]);
    // Schedule the next chunk against the settle's own timeline rather than
    // "as soon as possible": the simulation is far faster than the animation
    // it is driving, so without this it races to the end and the reader sees
    // one frame.
    const due = (step / iterations) * SETTLE_MS - (performance.now() - startedAt);
    scope.setTimeout(advance, Math.max(0, due));
  };

  const run = (): void => {
    const alpha = Math.pow(1 - step / iterations, 1.35);
    const root = tree(positions);
    for (let index = 0; index < positions.length / 2; index += 1) {
      repel(index, root, positions, velocity, alpha);
      collide(index, root, positions, radii, velocity);
    }
    for (let edge = 0; edge < edges.length; edge += 2) {
      const left = edges[edge];
      const right = edges[edge + 1];
      const lx = left * 2;
      const rx = right * 2;
      const dx = positions[rx] - positions[lx];
      const dy = positions[rx + 1] - positions[lx + 1];
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const wanted = 7.2 + radii[left] + radii[right];
      const pull = ((distance - wanted) / distance) * 0.018 * alpha;
      velocity[lx] += dx * pull;
      velocity[lx + 1] += dy * pull;
      velocity[rx] -= dx * pull;
      velocity[rx + 1] -= dy * pull;
    }
    // Cohesion: every page leans toward its own domain's centroid, so a
    // domain settles as one compact patch rather than strung out along the
    // links it shares with its neighbours.
    sumX.fill(0);
    sumY.fill(0);
    size.fill(0);
    for (let index = 0; index < groups.length; index += 1) {
      sumX[groups[index]] += positions[index * 2];
      sumY[groups[index]] += positions[index * 2 + 1];
      size[groups[index]] += 1;
    }
    for (let index = 0; index < positions.length / 2; index += 1) {
      const offset = index * 2;
      const group = groups[index];
      velocity[offset] += (sumX[group] / size[group] - positions[offset]) * 0.012 * alpha;
      velocity[offset + 1] += (sumY[group] / size[group] - positions[offset + 1]) * 0.012 * alpha;
      // Held in harder vertically than across: the field is wide, so the
      // domains are encouraged to sit side by side rather than stacked. The
      // across pull is what holds a domain no link reaches: at 0.0004 one sat
      // 26 units from its nearest neighbour on a real 32-page account; 0.00075
      // brings that to 20 while linked domains stay at the minimum gap.
      velocity[offset] += (80 - positions[offset]) * 0.00075 * alpha;
      velocity[offset + 1] += (45 - positions[offset + 1]) * 0.0024 * alpha;
      velocity[offset] *= 0.82;
      velocity[offset + 1] *= 0.82;
      positions[offset] += velocity[offset];
      positions[offset + 1] += velocity[offset + 1];
    }
    // Domains part as whole groups, a little every step, so the reader
    // watches them settle into separate regions rather than jump at the end.
    separateClusters(positions, radii, groups, groupCount, { passes: 1, strength: 0.35 });
  };

  advance();
};

export {};
