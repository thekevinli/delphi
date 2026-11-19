"use client";

/**
 * Where the open thing sits in everything the account knows.
 *
 * Mounted by both shells now: on the wiki it centres on the page being read,
 * and in the Reader on the page written *from* the open document — which is
 * the same relationship, because a document is a source and a source has a
 * page. Keeping it one component is what stops the two growing different
 * ideas of what "related" means.
 *
 * Extracted from `MemoryWorkspace` unchanged: its props were already
 * shell-agnostic, which is the sign that it should not have been living
 * inside one shell.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import RelatedTitle from "./ScrollingTitle";

import type { MemoryPageSummary } from "../lib/api";
import {
  type GraphNode,
  graphPreviewExcerpt,
  graphScale,
  relatedMemory,
} from "../lib/memory";

type RelatedLabelPlacement = {
  x: number;
  y: number;
  anchor: "middle" | "start" | "end";
  box: { x0: number; y0: number; x1: number; y1: number };
};

/**
 * The graph's metrics, in CSS pixels, at a 14-inch screen's rail.
 *
 * The SVG's viewBox tracks its measured size 1:1, so these *are* pixels on
 * screen at any rail width. The picture used to be a fixed 200×152 viewBox
 * scaled to the column, so widening the rail magnified everything, the space
 * between pages included. Now room shows more of the graph first; the dots and
 * type grow with it only gently, by `graphScale` (`scaledGraph`): the dots to
 * at most twice these on a very large rail, the type only to `labelMax`.
 */
const GRAPH = {
  nodeRadius: 3.6,
  currentRadius: 5.8,
  labelFont: 9.5,
  /** Average advance width of the label face at `labelFont`, measured once. */
  labelChar: 4.85,
  labelHeight: 11,
  /** The largest a name grows: a little over the list's 13px titles under the graph. */
  labelMax: 15,
  /** Gap between a dot and its label. */
  labelClear: 10,
  /** Inset kept clear of the card's rounded edge. */
  padding: 14,
  /**
   * Divides the box's *linear* extent — √area — to get a node count.
   *
   * Not area itself, which was the first attempt and grows quadratically: a
   * rail dragged from 300px to 420px doubles its area and so doubled the
   * count, packing a postcard with labels while a much wider rail hit the
   * ceiling immediately. What actually limits the map is how many labels tile
   * across it, and that grows with the edge, not the surface. At ~300px this
   * gives ten pages and at ~700px twenty-four, with the density falling as it
   * grows — which is what makes the bigger map more readable rather than just
   * fuller.
   */
  extentPerNode: 24,
  minNodes: 6,
  maxNodes: 26,
  /**
   * Memory's rail card, whose height is fixed: only its width earns nodes, and
   * its foot belongs to the Back to map pill. Nine pages at the rail's full
   * width, six once a conversation has narrowed it.
   */
  memoryWidthPerNode: 29,
  memoryMinNodes: 5,
  memoryFoot: 36,
  /** The graph box's √area on a 14-inch screen, the Reader's card and Memory's alike (266×200, 262×214). */
  reference: 240,
} as const;

type GraphMetrics = Record<"nodeRadius" | "currentRadius" | "labelFont" | "labelChar" | "labelHeight" | "labelClear" | "labelMinWidth" | "nodeClear", number>;

/**
 * The legibility metrics at a `graphScale`: dots and a name's clearance grow
 * together, and the type with them until it reaches `labelMax`.
 */
function scaledGraph(scale: number): GraphMetrics {
  const type = Math.min(scale, GRAPH.labelMax / GRAPH.labelFont);
  return {
    nodeRadius: GRAPH.nodeRadius * scale,
    currentRadius: GRAPH.currentRadius * scale,
    labelFont: GRAPH.labelFont * type,
    labelChar: GRAPH.labelChar * type,
    labelHeight: GRAPH.labelHeight * type,
    labelClear: GRAPH.labelClear * scale,
    labelMinWidth: 24 * type,
    /** Air a name keeps from another page's dot. */
    nodeClear: 2 * scale,
  };
}

/** The graph's own pixel size, so the drawing can be laid out in it. */
function useMeasuredBox() {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  /*
   * A callback ref, not a mount effect.
   *
   * The graph is unmounted while a conversation is docked, so on the rail's own
   * mount there is no node to observe — and an effect with `[]` deps never runs
   * again to notice one arriving. Closing the chat therefore drew the map at
   * the `{0, 0}` fallback for the rest of the session: capacity froze at its
   * floor of ten, the layout used the 200×152 default and was then stretched to
   * fill the card, the settle animation returned early and never ran, and every
   * label was judged "outside" a box two pixels wide and dropped. One stale
   * measurement, four symptoms that look unrelated.
   */
  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Rounded so a sub-pixel reflow does not restart the settle animation.
      setBox((current) =>
        Math.round(current.width) === Math.round(width) &&
        Math.round(current.height) === Math.round(height)
          ? current
          : { width, height },
      );
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  return [ref, box] as const;
}

/**
 * Ease the drawing into its new shape instead of cutting to it.
 *
 * Resizing the rail changes how many pages fit, so nodes arrive and leave and
 * the survivors move — as a hard swap that reads as the picture flickering
 * rather than as a graph settling. This springs every node toward its target,
 * with a little overshoot, which is the motion a force-directed graph has when
 * you let go of it and the reason it reads as one object rearranging itself.
 *
 * A node seen for the first time starts at the centre and flies out; one that
 * has gone simply stops being drawn. Positions are held in a ref and pushed to
 * state per frame, so the spring runs at display rate rather than at React's.
 */
function useSettledPositions(
  targets: Map<string, { x: number; y: number }>,
  box: { width: number; height: number },
) {
  // Positions live in state, velocities in a ref. The split matters: the
  // render reads only state, and the ref is touched exclusively inside the
  // animation frame — a ref read during render is exactly the stale-value bug
  // the react-hooks rule exists to catch.
  const [rendered, setRendered] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const motion = useRef(new Map<string, { x: number; y: number; vx: number; vy: number }>());

  useEffect(() => {
    if (!box.width || !box.height) return;
    const center = { x: box.width / 2, y: box.height / 2 };
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame: number | null = null;

    const seed = () => {
      for (const slug of [...motion.current.keys()]) {
        if (!targets.has(slug)) motion.current.delete(slug);
      }
      for (const [slug, point] of targets) {
        if (motion.current.has(slug)) continue;
        // New arrivals fly out of the middle, which is where the page they are
        // related *to* sits — so the motion reads as the neighbourhood growing
        // rather than as dots appearing from nowhere.
        motion.current.set(
          slug,
          reduced ? { ...point, vx: 0, vy: 0 } : { ...center, vx: 0, vy: 0 },
        );
      }
    };

    const publish = () => {
      const next = new Map<string, { x: number; y: number }>();
      for (const [slug, node] of motion.current) next.set(slug, { x: node.x, y: node.y });
      setRendered(next);
    };

    const step = () => {
      let moving = false;
      for (const [slug, target] of targets) {
        const node = motion.current.get(slug);
        if (!node) continue;
        // Under-damped on purpose: critical damping arrives correctly and
        // reads as a slide, and the small overshoot is what makes it look
        // like a graph settling rather than a transition playing.
        node.vx = (node.vx + (target.x - node.x) * 0.22) * 0.76;
        node.vy = (node.vy + (target.y - node.y) * 0.22) * 0.76;
        node.x += node.vx;
        node.y += node.vy;
        if (
          Math.abs(target.x - node.x) > 0.1 ||
          Math.abs(target.y - node.y) > 0.1 ||
          Math.abs(node.vx) > 0.1 ||
          Math.abs(node.vy) > 0.1
        ) {
          moving = true;
        }
      }
      publish();
      frame = moving ? requestAnimationFrame(step) : null;
    };

    // Seeded and published inside the frame rather than in the effect body, so
    // nothing sets state synchronously on the way in.
    frame = requestAnimationFrame(() => {
      seed();
      if (reduced) {
        for (const [slug, point] of targets) {
          motion.current.set(slug, { ...point, vx: 0, vy: 0 });
        }
        publish();
        frame = null;
        return;
      }
      step();
    });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [targets, box.width, box.height]);

  // Before the first frame there is nothing to draw from, so fall back to the
  // targets rather than stacking every node on the origin.
  return rendered.size ? rendered : targets;
}


const RELATED_LABEL_DIRECTIONS = [
  { dx: 0, dy: -1, anchor: "middle" as const },
  { dx: 1, dy: -1, anchor: "start" as const },
  { dx: 1, dy: 0, anchor: "start" as const },
  { dx: 1, dy: 1, anchor: "start" as const },
  { dx: 0, dy: 1, anchor: "middle" as const },
  { dx: -1, dy: 1, anchor: "end" as const },
  { dx: -1, dy: 0, anchor: "end" as const },
  { dx: -1, dy: -1, anchor: "end" as const },
];

function relatedLabelText(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 11)}…` : trimmed;
}

function relatedLabelPlacements(
  nodes: GraphNode[],
  positions: Map<string, { x: number; y: number }>,
  edges: Array<{ from: string; to: string }>,
  currentSlug: string | null,
  box: { width: number; height: number },
  metrics: GraphMetrics,
): Map<string, RelatedLabelPlacement> {
  const labels = new Map<string, RelatedLabelPlacement>();
  const boxes: RelatedLabelPlacement["box"][] = [];
  const labelNodes = nodes
    .filter((node) => node.slug !== currentSlug)
    .slice()
    // Reserve the cleanest positions in visual order: begin at north and
    // walk clockwise so a label never steals the space of a node that is
    // still to be visited on the other side of the graph.
    .sort((left, right) => {
      const leftPoint = positions.get(left.slug);
      const rightPoint = positions.get(right.slug);
      if (!leftPoint || !rightPoint) return leftPoint ? -1 : rightPoint ? 1 : 0;
      const cx = box.width / 2;
      const cy = box.height / 2;
      const angle = (point: { x: number; y: number }) => {
        const value = Math.atan2(point.x - cx, cy - point.y);
        return value < 0 ? value + Math.PI * 2 : value;
      };
      return angle(leftPoint) - angle(rightPoint) ||
        Math.hypot(leftPoint.x - cx, leftPoint.y - cy) - Math.hypot(rightPoint.x - cx, rightPoint.y - cy) ||
        left.title.localeCompare(right.title);
    });
  const overlaps = (left: RelatedLabelPlacement["box"], right: RelatedLabelPlacement["box"]) =>
    left.x0 < right.x1 && right.x0 < left.x1 && left.y0 < right.y1 && right.y0 < left.y1;
  const circleHits = (
    box: RelatedLabelPlacement["box"],
    point: { x: number; y: number },
    radius: number,
  ) => {
    const x = Math.max(box.x0, Math.min(point.x, box.x1));
    const y = Math.max(box.y0, Math.min(point.y, box.y1));
    return Math.hypot(point.x - x, point.y - y) < radius;
  };
  const cross = (
    left: { x: number; y: number },
    right: { x: number; y: number },
    point: { x: number; y: number },
  ) => (right.x - left.x) * (point.y - left.y) - (right.y - left.y) * (point.x - left.x);
  const onSegment = (
    left: { x: number; y: number },
    right: { x: number; y: number },
    point: { x: number; y: number },
  ) =>
    Math.min(left.x, right.x) - 0.01 <= point.x &&
    point.x <= Math.max(left.x, right.x) + 0.01 &&
    Math.min(left.y, right.y) - 0.01 <= point.y &&
    point.y <= Math.max(left.y, right.y) + 0.01;
  const segmentsIntersect = (
    first: { x: number; y: number },
    second: { x: number; y: number },
    third: { x: number; y: number },
    fourth: { x: number; y: number },
  ) => {
    const a = cross(first, second, third);
    const b = cross(first, second, fourth);
    const c = cross(third, fourth, first);
    const d = cross(third, fourth, second);
    return (
      ((a > 0 && b < 0) || (a < 0 && b > 0)) &&
        ((c > 0 && d < 0) || (c < 0 && d > 0)) ||
      (Math.abs(a) < 0.01 && onSegment(first, second, third)) ||
      (Math.abs(b) < 0.01 && onSegment(first, second, fourth)) ||
      (Math.abs(c) < 0.01 && onSegment(third, fourth, first)) ||
      (Math.abs(d) < 0.01 && onSegment(third, fourth, second))
    );
  };
  const edgeHits = (box: RelatedLabelPlacement["box"]) => {
    const corners = [
      { x: box.x0, y: box.y0 },
      { x: box.x1, y: box.y0 },
      { x: box.x1, y: box.y1 },
      { x: box.x0, y: box.y1 },
    ];
    return edges.some((edge) => {
      const first = positions.get(edge.from);
      const second = positions.get(edge.to);
      if (!first || !second) return false;
      if (
        first.x >= box.x0 && first.x <= box.x1 && first.y >= box.y0 && first.y <= box.y1 ||
        second.x >= box.x0 && second.x <= box.x1 && second.y >= box.y0 && second.y <= box.y1
      ) return true;
      return corners.some((corner, index) =>
        segmentsIntersect(first, second, corner, corners[(index + 1) % corners.length]),
      );
    });
  };

  for (const node of labelNodes) {
    const point = positions.get(node.slug);
    if (!point) continue;
    const text = relatedLabelText(node.title);
    const width = Math.max(metrics.labelMinWidth, text.length * metrics.labelChar);
    const height = metrics.labelHeight;
    const clear = metrics.labelClear;
    const candidates = RELATED_LABEL_DIRECTIONS.map((direction) => {
      const x = point.x + direction.dx * clear;
      const y = point.y + direction.dy * clear +
        (direction.dy > 0 ? height : direction.dy === 0 ? height * 0.35 : 0);
      const x0 = direction.anchor === "middle" ? x - width / 2 : direction.anchor === "start" ? x : x - width;
      return {
        x,
        y,
        anchor: direction.anchor,
        box: { x0, y0: y - height, x1: x0 + width, y1: y },
      };
    });
    let backup: RelatedLabelPlacement | null = null;
    let chosen: RelatedLabelPlacement | null = null;
    for (const candidate of candidates) {
      // Inside the *card*, not merely inside the viewBox: the graph clips to a
      // rounded frame, so a label flush with the edge loses its last letters.
      const outside =
        candidate.box.x0 < 2 ||
        candidate.box.x1 > box.width - 2 ||
        candidate.box.y0 < 2 ||
        candidate.box.y1 > box.height - 2;
      const labelCollision = boxes.some((box) => overlaps(box, candidate.box));
      const nodeCollision = nodes.some((other) => {
        if (other.slug === node.slug) return false;
        const otherPoint = positions.get(other.slug);
        return otherPoint && circleHits(
          candidate.box,
          otherPoint,
          (other.slug === currentSlug ? metrics.currentRadius : metrics.nodeRadius) + metrics.nodeClear,
        );
      });
      if (outside || labelCollision || nodeCollision) continue;
      if (!edgeHits(candidate.box)) {
        chosen = candidate;
        break;
      }
      backup ??= candidate;
    }
    chosen ??= backup;
    if (chosen) {
      boxes.push(chosen.box);
      labels.set(node.slug, chosen);
    }
  }
  return labels;
}

export function RelatedMemoryRail({
  currentSlug,
  pages,
  links,
  domains,
  hops,
  distances,
  hideGraph,
  collapsed,
  onCollapse,
  onOpen,
  onWholeGraph,
  layout = "rail",
}: {
  currentSlug: string | null;
  pages: MemoryPageSummary[];
  links: Array<{ from: string; to: string }>;
  domains: Array<{ slug: string; title: string }>;
  hops: number;
  distances: Record<string, number>;
  hideGraph?: boolean;
  /** Kept mounted while the rail is a spine, so expanding it is instant. */
  collapsed?: boolean;
  onCollapse?: () => void;
  onOpen: (slug: string) => void;
  onWholeGraph: () => void;
  /**
   * `memory` is Memory's page view, where this is the left rail: the linked
   * pages come first as plain titles, and the local map sits at the foot with
   * the way back to the full map inside it.
   */
  layout?: "rail" | "memory";
}) {
  const [hoveredSlug, setHoveredSlug] = useState<string | null>(null);
  const [graphRef, box] = useMeasuredBox();
  const related = useMemo(
    () => relatedMemory(currentSlug ?? "", pages, links, domains, distances),
    [currentSlug, pages, links, domains, distances],
  );
  /**
   * How many pages the picture can hold at this size.
   *
   * The only thing that varies with room. Derived from drawable area rather
   * than from width alone, so a rail that grows taller earns nodes too, and
   * clamped at both ends: below the floor the map stops showing a
   * neighbourhood at all, and above the ceiling it stops being something a
   * person can read at a glance and becomes the full graph — which has its own
   * route.
   */
  const memory = layout === "memory";
  const scale = graphScale(box.width, box.height, GRAPH.reference);
  const metrics = useMemo(() => scaledGraph(scale), [scale]);
  /** The part of the box nodes and labels may use: all of it but the pill's foot. */
  const field = useMemo(
    () => ({
      width: box.width,
      height: Math.max(0, box.height - (memory ? GRAPH.memoryFoot : 0)),
    }),
    [box.width, box.height, memory],
  );
  const capacity = useMemo(() => {
    if (!box.width || !box.height) return 10;
    if (memory) {
      return Math.max(
        GRAPH.memoryMinNodes,
        Math.min(GRAPH.maxNodes, Math.round(box.width / (GRAPH.memoryWidthPerNode * Math.sqrt(scale)))),
      );
    }
    const drawable =
      Math.max(0, box.width - GRAPH.padding * 2) *
      Math.max(0, box.height - GRAPH.padding * 2);
    return Math.max(
      GRAPH.minNodes,
      Math.min(
        GRAPH.maxNodes,
        // Larger names each need more of the field.
        Math.round(Math.sqrt(drawable) / (GRAPH.extentPerNode * Math.sqrt(scale))),
      ),
    );
  }, [box.width, box.height, memory, scale]);

  // The complete neighborhood can contain hundreds of linked pages. Keep that
  // truth in the ordered list, while the picture shows a representative local
  // map a person can actually parse — as much of one as fits.
  const visual = useMemo(() => {
    const selected = new Set<string>();
    if (currentSlug) selected.add(currentSlug);
    const rank = (left: GraphNode, right: GraphNode) =>
      right.degree - left.degree || left.title.localeCompare(right.title);
    // First hop keeps the larger share, because the pages one link away are
    // what "related" means; the second hop is context around them.
    const firstHop = Math.max(3, Math.round((capacity - 1) * 0.45));
    const secondHop = Math.max(2, capacity - 1 - firstHop);
    const pick = (distance: number, limit: number) => related.nodes
      .filter((node) => !selected.has(node.slug) && related.distances.get(node.slug) === distance)
      .slice()
      .sort(rank)
      .slice(0, limit);
    for (const node of pick(1, firstHop)) selected.add(node.slug);
    for (const node of pick(2, secondHop)) selected.add(node.slug);

    // If this local neighborhood has fewer than two hops, fill the remaining
    // visual slots from the next closest pages without changing the ordered
    // list below it.
    const ranked = related.nodes
      .filter((node) => !selected.has(node.slug))
      .slice()
      .sort((left, right) =>
        (related.distances.get(left.slug) ?? Infinity) -
          (related.distances.get(right.slug) ?? Infinity) ||
        right.degree - left.degree ||
        left.title.localeCompare(right.title),
      );
    for (const node of ranked) {
      if (selected.size >= capacity) break;
      selected.add(node.slug);
    }
    return {
      nodes: related.nodes.filter((node) => selected.has(node.slug)),
      edges: related.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
      // Counted from what is actually drawn, so it falls as the picture grows
      // and rises as it shrinks rather than quoting a number from a fixed ten.
      hidden: Math.max(
        0,
        related.pages.length - related.nodes.filter(
          (node) => selected.has(node.slug) && node.slug !== currentSlug && node.openable,
        ).length,
      ),
    };
  }, [currentSlug, capacity, related]);

  /** Where the relaxation wants each node, in the graph's own pixels. */
  const targets = useMemo(() => {
    const result = new Map<string, { x: number; y: number }>();
    const width = field.width || 200;
    const height = field.height || 152;
    const center = { x: width / 2, y: height / 2 };
    // Rings scale with the box, the nodes far less: a wider graph spreads its
    // neighbourhood out and takes on more of it.
    const span = Math.min(width, height) / 2 - GRAPH.padding;
    const squash = height / Math.max(1, width) < 0.72 ? 0.8 : 0.95;
    const movable = visual.nodes.filter((node) => node.slug !== currentSlug);
    const hash = (value: string) => {
      let total = 0;
      for (let index = 0; index < value.length; index += 1) total = (total * 31 + value.charCodeAt(index)) >>> 0;
      return total;
    };
    result.set(currentSlug ?? "", center);
    movable.forEach((node, index) => {
      const distance = related.distances.get(node.slug) ?? hops;
      const seed = hash(node.slug);
      const angle = -Math.PI / 2 + index * 2.399963 + ((seed % 23) - 11) * 0.018;
      const ring = span * (distance <= 1 ? 0.56 : 0.92);
      const alternating = span * (index % 2 === 0 ? -0.06 : 0.07);
      const radius = ring + alternating + ((seed % 13) - 6) * (span * 0.012);
      result.set(node.slug, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * squash,
      });
    });

    // A short deterministic relaxation keeps the map stable between renders,
    // but lets dense branches spread instead of collapsing into a perfect,
    // unreadable necklace. The open page remains the visual anchor.
    const separation = Math.max(20 * scale, span * 0.34);
    for (let iteration = 0; iteration < 70; iteration += 1) {
      const shifts = new Map<string, { x: number; y: number }>();
      for (const node of movable) shifts.set(node.slug, { x: 0, y: 0 });
      for (let leftIndex = 0; leftIndex < movable.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < movable.length; rightIndex += 1) {
          const left = movable[leftIndex];
          const right = movable[rightIndex];
          const leftPoint = result.get(left.slug)!;
          const rightPoint = result.get(right.slug)!;
          const dx = leftPoint.x - rightPoint.x;
          const dy = leftPoint.y - rightPoint.y;
          const length = Math.max(2, Math.hypot(dx, dy));
          const push = Math.max(0, separation - length) * 0.045;
          shifts.get(left.slug)!.x += (dx / length) * push;
          shifts.get(left.slug)!.y += (dy / length) * push;
          shifts.get(right.slug)!.x -= (dx / length) * push;
          shifts.get(right.slug)!.y -= (dy / length) * push;
        }
      }
      for (const node of movable) {
        const point = result.get(node.slug)!;
        const shift = shifts.get(node.slug)!;
        const distance = related.distances.get(node.slug) ?? hops;
        const targetRadius = span * (distance <= 1 ? 0.58 : 0.94);
        const dx = point.x - center.x;
        const dy = (point.y - center.y) / squash;
        const radius = Math.max(1, Math.hypot(dx, dy));
        const radialPull = (targetRadius - radius) * 0.018;
        result.set(node.slug, {
          x: Math.max(
            GRAPH.padding,
            Math.min(width - GRAPH.padding, point.x + shift.x + (dx / radius) * radialPull),
          ),
          y: Math.max(
            GRAPH.padding,
            Math.min(height - GRAPH.padding, point.y + shift.y + (dy / radius) * radialPull * squash),
          ),
        });
      }
    }
    return result;
  }, [visual.nodes, related.distances, currentSlug, hops, field.width, field.height, scale]);

  const positions = useSettledPositions(targets, box);
  const labelled = useMemo(() => {
    return relatedLabelPlacements(visual.nodes, positions, visual.edges, currentSlug, field, metrics);
  }, [visual.nodes, visual.edges, positions, currentSlug, field, metrics]);
  const graph = (extra?: ReactNode) => (
    <div className="kb-related-graph" ref={graphRef}>
          {/* 1:1 with the measured box, so a unit here is a pixel on screen and
              the type and dots are sized by `metrics` alone. A fixed viewBox
              magnified them with the rail instead. */}
          <svg
            viewBox={`0 0 ${box.width || 200} ${box.height || 152}`}
            style={{ fontSize: metrics.labelFont }}
            role="img"
            aria-label={`${hops}-step related Memory map`}
          >
          {visual.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            return from && to ? <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null;
          })}
          {visual.nodes.map((node) => {
            const point = positions.get(node.slug);
            if (!point) return null;
            const current = node.slug === currentSlug;
            const label = current ? null : labelled.get(node.slug);
            return (
              <g
                key={node.slug}
                className={`kb-related-node kb-related-node-${node.kind}${current ? " current" : ""}`}
                onClick={() => node.openable && onOpen(node.slug)}
                onMouseDown={(event) => {
                  // A mouse-down focuses a tabindex SVG group, and Safari then
                  // outlines the whole `<g>` — circle plus label — in its
                  // default blue ring. Pointer feedback is the hover tooltip;
                  // do not take focus from a press. Click still fires.
                  event.preventDefault();
                }}
                onPointerEnter={() => setHoveredSlug(node.slug)}
                onPointerLeave={() => setHoveredSlug(null)}
                onFocus={() => setHoveredSlug(node.slug)}
                onBlur={() => setHoveredSlug(null)}
                role={node.openable ? "button" : undefined}
                tabIndex={node.openable ? 0 : undefined}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={current ? metrics.currentRadius : metrics.nodeRadius}
                />
                {!current && label ? (
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor={label.anchor}
                  >
                    {relatedLabelText(node.title)}
                  </text>
                ) : null}
              </g>
            );
          })}
          </svg>
          {hoveredSlug ? (() => {
            const node = visual.nodes.find((entry) => entry.slug === hoveredSlug);
            const point = node ? positions.get(node.slug) : null;
            if (!node || !point) return null;
            // Keep the bubble above its node when there is room, but clamp its
            // anchor toward the middle of the graph when a long title would
            // otherwise be clipped by the graph's rounded frame.
            // Reserve a 10px visual inset on either side of the graph. The
            // node's preferred north/clockwise placement remains unchanged;
            // this only nudges a wide bubble inward when it would touch a
            // rounded edge.
            const width = box.width || 200;
            const height = box.height || 152;
            const estimatedWidth = Math.min(width - 24, Math.max(44, node.title.length * 6));
            const safeX = Math.max(
              10 + estimatedWidth / 2,
              Math.min(width - 10 - estimatedWidth / 2, point.x),
            );
            const tooltipX = `${(safeX / width) * 100}%`;
            // The graph clips its contents to the rounded card. Give the
            // bubble enough room above the anchor to keep both lines and the
            // rounded top edge visible when a node sits near the ceiling.
            const tooltipY = `${Math.max(30, Math.min(90, (point.y / height) * 100))}%`;
            return (
              <div
                className="kb-related-tooltip"
                style={{ left: tooltipX, top: tooltipY }}
                role="tooltip"
              >
                {node.title}
              </div>
            );
          })() : null}
          {/* Only the count: the list under the card already shows every page,
              so the graph's corner just says how many it left out. */}
          {visual.hidden ? (
            <span
              className="kb-related-hidden"
              role="note"
              aria-label={`${visual.hidden} more page${visual.hidden === 1 ? "" : "s"} in the list ${memory ? "above" : "below"}`}
            >
              +{visual.hidden}
            </span>
          ) : null}
      {extra}
    </div>
  );
  if (layout === "memory") {
    return (
      <section className="kb-related kb-related-memory">
        <p className="kb-memory-label">Linked pages</p>
        <ol className="kb-related-list">
          {related.pages.map((page) => (
            <li key={page.slug}>
              <button type="button" onClick={() => onOpen(page.slug)}>
                <span className={`kb-page-dot kb-page-dot-${page.kind}`} aria-hidden="true" />
                <span><RelatedTitle title={page.title} /></span>
              </button>
            </li>
          ))}
          {related.pages.length === 0 ? <li className="kb-memory-empty">No links yet.</li> : null}
        </ol>
        {graph(
          <button type="button" className="kb-related-back" onClick={onWholeGraph}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" /></svg>
            Back to map
          </button>,
        )}
      </section>
    );
  }
  return (
    <section className={`kb-related${collapsed ? " is-hidden" : ""}`} aria-hidden={collapsed}>
      <div className={`kb-related-pin${hideGraph ? " kb-related-pin-list-only" : ""}`}>
        <header>
          <h3>Related Memory</h3>
          {onCollapse ? (
            /* The way back to the spine. Without it the collapsed state was
               reachable only by arriving in Find mode, which made it look
               like something that had happened to the rail rather than
               something the reader can do to it. */
            <button
              type="button"
              className="kb-related-collapse"
              onClick={onCollapse}
              aria-label="Collapse Related Memory"
              aria-expanded={true}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="m6 6 4 4-4 4M14.5 4.6v10.8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          ) : null}
          {/* A glyph at rest and its name on request, like Ask Delphi in the
              bar: the arrowed link was the loudest words in the column. */}
          <button type="button" className="kb-related-full" onClick={onWholeGraph} aria-label="Full map">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
            </svg>
            <span>Full map</span>
          </button>
        </header>
        {!hideGraph ? graph() : null}
      </div>
      <ol className="kb-related-list">
        {related.pages.map((page) => (
          <li key={page.slug}>
            <button type="button" onClick={() => onOpen(page.slug)}>
              <span className={`kb-page-dot kb-page-dot-${page.kind}`} aria-hidden="true" />
              <span><RelatedTitle title={page.title} /><small>{graphPreviewExcerpt(page.summary, 14)}</small></span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * One Update surface: documents to file and pages to re-file, never two cards.
 *
 * Lands from the top like document-processing, with the sunrise mark. Accepting
 * applies every proposed move and starts filing — there is no second Apply step
 * and no Refile-all twin, so the banner stays one decision.
 *
 * Copy is always a heavy title plus an optional lighter detail — every outcome
 * uses that split, not only the idle "nothing misfiled" case.
 */
