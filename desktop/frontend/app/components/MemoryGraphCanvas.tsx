"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { MemoryDomain, MemoryPageSummary } from "../lib/api";
import {
  KIND_LABELS,
  boundedView,
  boxesOverlap,
  buildGraph,
  circleHitsBox,
  graphPreviewExcerpt,
  graphScale,
  labelSlots,
  placeDomainName,
  type Box,
  type GraphNode,
  type GraphView as View,
} from "../lib/memory";
import {
  DENSE_CLUSTERS, circlesFit, clusterArrangements, clusterCircles, type ClusterCircle,
} from "../lib/memory-clusters";
import { LAYOUT_CACHE_PREFIX, rememberLayout } from "../lib/layout-cache";
import { followPointer } from "../lib/pointer-gesture";
import { GraphMark, LoadingCaption, LoadingWords } from "./Loading";

type LegendEntry = {
  kind: GraphNode["kind"];
  label: string;
  hint: string;
};

const ASPECT = 16 / 9;
const HOME = { x: 0, y: 0, size: 90 };
const VISUAL_RADIUS = 0.68;
const GRID_SIZE = 24;
/**
 * The √area, in CSS pixels, each map's field has on a 14-inch screen: there
 * its dots and names are drawn at their base size, and they grow with the
 * field from there (`graphScale`).
 */
const MAP_REFERENCE = 1000; // 1178×811
const CARD_REFERENCE = 400; // 464×331

const COLOR_VARIABLE: Record<GraphNode["kind"], string> = {
  domain: "--kb-node-domain",
  concept: "--kb-node-concept",
  source: "--kb-node-source",
};

type Preview = {
  node: GraphNode;
  x: number;
  y: number;
  /** A click holds the card open; a hover lets it close on the way out. */
  pinned: boolean;
  // The card opens down-and-right from the dot, so a node low or far right
  // in the field would run it off a canvas that does not scroll. `placed`
  // says the flip below has already measured this card; without it the
  // measurement would set state that re-runs the measurement forever.
  placed: boolean;
  originX: "left" | "right";
  originY: "top" | "bottom";
};

export function MemoryGraphCanvas({
  revision,
  pages,
  links,
  domains,
  onOpen,
  ready,
  compact = false,
  focusDomain = null,
  onFocusDomain,
}: {
  revision: number;
  pages: MemoryPageSummary[];
  links: Array<{ from: string; to: string }>;
  domains: Array<Pick<MemoryDomain, "slug" | "title">>;
  onOpen: (slug: string) => void;
  ready: boolean;
  /** Retired with the full graph's side key; the Dashboard draws its own. */
  legend?: LegendEntry[];
  /** The Dashboard's Memory panel: the canvas alone, inside a card that
   *  already names what it is. Its pages are named only when a domain is
   *  focused. */
  compact?: boolean;
  /** The domain the map is zoomed into, or null for every domain. */
  focusDomain?: string | null;
  /** A domain's label on the map was pressed, or the map was fitted back out. */
  onFocusDomain?: (slug: string | null) => void;
}) {
  const graph = useMemo(() => buildGraph(pages, links, domains), [pages, links, domains]);
  /**
   * Which domain each node is filed under, as a dense index. The worker keeps
   * each group together and parts groups until their circles clear; the draw
   * reads the same groups to put a circle around each domain.
   */
  const clusters = useMemo(() => {
    const index = new Map<string, number>();
    const groups = new Uint32Array(graph.nodes.length);
    const slugs: string[] = [];
    graph.nodes.forEach((node, position) => {
      // A node with no domain is its own group rather than a member of a
      // nameless one that would draw a circle around unrelated pages.
      const key = node.domain || `\u0000${node.slug}`;
      let group = index.get(key);
      if (group === undefined) {
        group = slugs.length;
        index.set(key, group);
        slugs.push(node.domain);
      }
      groups[position] = group;
    });
    const titles = slugs.map(
      (slug) =>
        domains.find((domain) => domain.slug === slug)?.title ??
        graph.nodes.find((node) => node.slug === slug)?.title ??
        slug,
    );
    const radii = Float32Array.from(graph.nodes.map((node) => node.r));
    return { groups, count: slugs.length, slugs, titles, radii };
  }, [graph, domains]);
  const focusRef = useRef<string | null>(focusDomain);
  /** The page under the pointer on the Dashboard's card, ringed as its name shows. */
  const hoverRef = useRef<string | null>(null);
  const regionHitsRef = useRef<Array<{ slug: string; box: Box }>>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoomBoxRef = useRef<Box | null>(null);
  const positionsRef = useRef<Float32Array>(new Float32Array());
  // Whether the layout has stopped moving. Labels are placed only when it has:
  // the placement is the expensive half of a draw, and a name that changes slot
  // every frame cannot be read regardless.
  const settledRef = useRef(false);
  const viewRef = useRef({ ...HOME });
  // The field's shape, measured from its box: the map's beside a docked
  // conversation and the Dashboard's long card alike. 16:9 until measured.
  const aspectRef = useRef(ASPECT);
  // The layout the worker settled, and which arrangement of its domains is
  // drawn: `positionsRef` is this with each domain shifted as a whole.
  const baseRef = useRef<Float32Array>(new Float32Array());
  const arrangementRef = useRef(0);
  const arrangeFrameRef = useRef(0);
  const hitGridRef = useRef(new Map<string, number[]>());
  const sizeRef = useRef({ width: 0, height: 0 });
  // A pan under way, followed until it is let go (`followPointer`).
  const dragRef = useRef<{ x: number; y: number; moved: boolean; stop: () => void } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The compact graph has no room for the preview card: it names the node
   *  under the pointer in a bubble, as Related Memory does, and a click
   *  opens the page. */
  const [tip, setTip] = useState<{ node: GraphNode; x: number; y: number; width: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = String(revision);

  const cancelPreviewClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closePreview = useCallback(() => {
    cancelPreviewClose();
    setPreview(null);
  }, [cancelPreviewClose]);

  /**
   * A hover leaves on a short delay so the pointer can travel from the dot
   * onto the card without the card disappearing under it; a pinned card, put
   * there by a click, ignores the leave entirely.
   */
  const schedulePreviewClose = useCallback(() => {
    cancelPreviewClose();
    closeTimerRef.current = window.setTimeout(() => {
      setPreview((current) => (current?.pinned ? current : null));
    }, 90);
  }, [cancelPreviewClose]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  /**
   * Flip the card back into the field before it is ever seen.
   *
   * It is anchored at the node so the dot reads as its upper-left corner, and
   * a node near the bottom or the right edge therefore pushes it off screen —
   * absolutely positioned over a canvas that does not scroll, so the part that
   * leaves is simply gone. Measured rather than guessed: the height depends on
   * the summary. The legend owns the rail to the right of the canvas, so the
   * field's own right edge is the wall here rather than the window's.
   */
  useLayoutEffect(() => {
    const card = previewRef.current;
    const wrap = wrapRef.current;
    if (!card || !wrap || !preview || preview.placed) return;
    const inner = card.firstElementChild as HTMLElement | null;
    const width = inner?.offsetWidth ?? card.offsetWidth;
    const height = inner?.offsetHeight ?? card.offsetHeight;
    const wrapRect = wrap.getBoundingClientRect();
    const margin = 16;
    const rightWall = Math.min(window.innerWidth - margin, wrapRect.right);
    let { x, y, originX, originY } = preview;
    if (wrapRect.left + x + width > rightWall) {
      x = Math.max(margin - wrapRect.left, x - width);
      originX = "right";
    }
    if (wrapRect.top + y + height > window.innerHeight - margin) {
      y = Math.max(margin - wrapRect.top, y - height);
      originY = "bottom";
    }
    setPreview({ ...preview, x, y, originX, originY, placed: true });
  }, [preview]);

  const showPreview = useCallback(
    (node: GraphNode, x: number, y: number, pinned: boolean) => {
      cancelPreviewClose();
      setPreview((current) =>
        // A hover crossing the node it is already describing must not re-place
        // the card, or it re-measures and jitters under the pointer.
        current && current.node.slug === node.slug && (current.pinned || !pinned)
          ? current
          : { node, x, y, pinned, placed: false, originX: "left", originY: "top" },
      );
    },
    [cancelPreviewClose],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || !width || !height || !ready) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(canvas);
    const view = viewRef.current;
    const viewWidth = view.size * aspectRef.current;
    const scaleX = width / viewWidth;
    const scaleY = height / view.size;
    const sx = (x: number) => (x - view.x) * scaleX;
    const sy = (y: number) => (y - view.y) * scaleY;
    const positions = positionsRef.current;
    const bySlug = new Map(graph.nodes.map((node, index) => [node.slug, index]));
    const unit = Math.min(scaleX, scaleY);
    const scale = graphScale(width, height, compact ? CARD_REFERENCE : MAP_REFERENCE);
    const focusGroup = focusRef.current ? clusters.slugs.indexOf(focusRef.current) : -1;
    const inFocus = (index: number) => focusGroup < 0 || clusters.groups[index] === focusGroup;

    // Each domain as a region: a faint wash inside a dashed ring, measured
    // from where its pages actually are. Behind everything else, so the
    // lines and dots read as sitting inside it.
    const circles: ClusterCircle[] =
      positions.length >= 2
        ? clusterCircles(positions, clusters.radii, clusters.groups, clusters.count)
        : [];
    const regionFill = styles.getPropertyValue("--kb-region-fill").trim() || "rgba(201, 78, 58, 0.03)";
    const regionStroke = styles.getPropertyValue("--kb-region-stroke").trim() || "#f1dcd6";
    const regionFocus = styles.getPropertyValue("--kb-region-focus").trim() || "#ebc3ba";
    // Hairlines thicken more gently than the dots: the square root of the scale.
    context.lineWidth = 1.2 * Math.sqrt(scale);
    context.setLineDash([5 * scale, 4 * scale]);
    for (const circle of circles) {
      if (!circle.size || !clusters.slugs[circle.group]) continue;
      const focused = circle.group === focusGroup;
      context.globalAlpha = focusGroup < 0 || focused ? 1 : 0.4;
      context.beginPath();
      context.arc(sx(circle.x), sy(circle.y), circle.r * unit, 0, Math.PI * 2);
      context.fillStyle = regionFill;
      context.fill();
      context.strokeStyle = focused ? regionFocus : regionStroke;
      context.stroke();
    }
    context.setLineDash([]);
    context.globalAlpha = 1;

    context.strokeStyle = styles.getPropertyValue("--line-strong").trim() || "#b9afa6";
    context.lineWidth = 0.7 * Math.sqrt(scale);
    // Two passes, so a zoomed-in domain's own lines are drawn at full
    // strength and every other line fades with the nodes it joins.
    for (const lit of [false, true]) {
    context.globalAlpha = lit ? 0.5 : focusGroup < 0 ? 0.5 : 0.1;
    context.beginPath();
    for (const edge of graph.edges) {
      const left = bySlug.get(edge.from);
      const right = bySlug.get(edge.to);
      if (left === undefined || right === undefined) continue;
      if ((inFocus(left) && inFocus(right)) !== lit) continue;
      const x1 = positions[left * 2];
      const y1 = positions[left * 2 + 1];
      const x2 = positions[right * 2];
      const y2 = positions[right * 2 + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const lr = graph.nodes[left].r * VISUAL_RADIUS;
      const rr = graph.nodes[right].r * VISUAL_RADIUS;
      context.moveTo(sx(x1 + (dx / distance) * lr), sy(y1 + (dy / distance) * lr));
      context.lineTo(sx(x2 - (dx / distance) * rr), sy(y2 - (dy / distance) * rr));
    }
    context.stroke();
    }
    context.globalAlpha = 1;

    const grid = new Map<string, number[]>();
    const paper = styles.getPropertyValue("--paper").trim() || "#fffdf9";
    const ink = styles.getPropertyValue("--ink").trim() || "#32271f";
    // Circles first, in one pass that also records where each one landed. The
    // labels need every dot's screen position before the first of them can be
    // placed, so they cannot share this loop: a name drawn here would only ever
    // have been checked against the nodes drawn before it.
    const drawn: Array<{ index: number; x: number; y: number; r: number }> = [];
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      const x = sx(positions[index * 2]);
      const y = sy(positions[index * 2 + 1]);
      // Grows with zoom, but not without limit: zoomed onto one domain the
      // dots stay dots and the room goes to the space between them.
      const radius = Math.min((6 + node.r * 2.4) * scale, Math.max(2.2 * scale, node.r * VISUAL_RADIUS * unit));
      if (x < -radius || y < -radius || x > width + radius || y > height + radius) continue;
      // Cells grow with the dots, so a press anywhere on one finds it.
      const cell = `${Math.floor(x / (GRID_SIZE * scale))}:${Math.floor(y / (GRID_SIZE * scale))}`;
      const bucket = grid.get(cell) ?? [];
      bucket.push(index);
      grid.set(cell, bucket);
      context.globalAlpha = inFocus(index) ? 1 : 0.16;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = styles.getPropertyValue(COLOR_VARIABLE[node.kind]).trim() || "#9c7b62";
      context.fill();
      if (compact && node.slug === hoverRef.current) {
        context.beginPath();
        context.arc(x, y, radius + 3 * scale, 0, Math.PI * 2);
        context.lineWidth = 1.6 * Math.sqrt(scale);
        context.strokeStyle = styles.getPropertyValue("--clay").trim() || "#5a2620";
        context.stroke();
      }
      drawn.push({ index, x, y, r: radius });
    }
    context.globalAlpha = 1;
    hitGridRef.current = grid;

    // Domain names ride the rings of their circles, as pills a reader can
    // press to zoom in. Placed before the page labels so those avoid them.
    const placedBoxes: Box[] = [];
    const regionHits: Array<{ slug: string; box: Box }> = [];
    // The Dashboard's card sets its names in the page's own face, as its
    // headings are; the full map keeps the system face.
    const face = (compact && styles.getPropertyValue("--font-sans").trim()) || "system-ui, sans-serif";
    if (settledRef.current) {
      context.font = `700 ${9 * scale}px ${face}`;
      context.textBaseline = "middle";
      context.textAlign = "center";
      const pillFill = styles.getPropertyValue("--kb-region-pill").trim() || "#ffffff";
      const pillStroke = styles.getPropertyValue("--kb-region-pill-stroke").trim() || regionStroke;
      const pillInk = styles.getPropertyValue("--kb-region-ink").trim() || "#a8423a";
      // The card's names float just above their rings rather than on them:
      // with no pill there, a name on the ring would have the dashes through it.
      const lift = compact ? 16 * scale : 0;
      // Largest domains first, so they keep the top of their rings. The zoom
      // control's corner counts as a name, measured once per size of field.
      const rings = circles.map((circle) => ({ circle, x: sx(circle.x), y: sy(circle.y), r: circle.r * unit }));
      if (!zoomBoxRef.current && zoomRef.current) {
        const zoom = zoomRef.current.getBoundingClientRect();
        const field = canvas.getBoundingClientRect();
        zoomBoxRef.current = { x0: zoom.left - field.left, y0: zoom.top - field.top, x1: zoom.right - field.left, y1: zoom.bottom - field.top };
      }
      if (zoomBoxRef.current) placedBoxes.push(zoomBoxRef.current);
      const measure = (line: string) => context.measureText(line).width + line.length * 0.9 * scale;
      for (const { circle, ...ring } of [...rings].sort((left, right) => right.r - left.r)) {
        const slug = clusters.slugs[circle.group];
        if (!circle.size || !slug) continue;
        const box = placeDomainName({
          text: clusters.titles[circle.group].toUpperCase(),
          ring,
          lift,
          scale,
          field: { width, height },
          measure,
          placed: placedBoxes,
          dots: drawn.filter((dot) => clusters.groups[dot.index] !== circle.group),
          rings: rings.filter((other) => other.circle.group !== circle.group),
        });
        if (!box) continue;
        context.globalAlpha = focusGroup < 0 || circle.group === focusGroup ? 1 : 0.4;
        context.beginPath();
        context.roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 10 * scale);
        context.fillStyle = pillFill;
        context.fill();
        context.lineWidth = Math.sqrt(scale);
        context.strokeStyle = pillStroke;
        context.stroke();
        context.fillStyle = pillInk;
        context.letterSpacing = `${0.9 * scale}px`;
        box.lines.forEach((line, at) =>
          context.fillText(line, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2 + (at - (box.lines.length - 1) / 2) * 12 * scale + 0.5));
        context.letterSpacing = "0px";
        const { x0, y0, x1, y1 } = box;
        placedBoxes.push({ x0, y0, x1, y1 });
        regionHits.push({ slug, box: { x0, y0, x1, y1 } });
      }
      context.globalAlpha = 1;
    }
    regionHitsRef.current = regionHits;
    // Where the names landed, written onto the canvas for the browser suite:
    // a canvas has no text a test could otherwise find or press.
    canvas.dataset.domains = JSON.stringify(regionHits.map(({ slug, box }) => ({
      slug, x: Math.round((box.x0 + box.x1) / 2), y: Math.round((box.y0 + box.y1) / 2),
    })));
    const named: string[] = [];
    canvas.dataset.pages = "[]";

    // Only once the layout has stopped moving. Placement is the expensive part
    // of drawing this graph and a name that jumps slot every frame is unreadable
    // anyway, so the settling animation carries no labels at all — which is also
    // what makes the cost below affordable: it is paid on settle, on pan and on
    // zoom, never sixty times a second.
    // The Dashboard's card is small: at rest its domains are named and its
    // pages are not — a page's name comes up on hover, as in Related
    // Memory. Zoomed onto one domain there is room, and its pages are named
    // by the same placement the full map runs all the time.
    if ((compact && focusGroup < 0) || !settledRef.current || view.size > 110) return;
    context.font = `500 ${10 * scale}px ${face}`;
    context.textBaseline = "middle";
    const height10 = 11 * scale;
    const ranked = [...drawn].sort(
      (left, right) =>
        graph.nodes[right.index].degree - graph.nodes[left.index].degree ||
        graph.nodes[left.index].slug.localeCompare(graph.nodes[right.index].slug),
    );
    for (const spot of ranked.slice(0, 42)) {
      const node = graph.nodes[spot.index];
      // Outside a zoomed-in domain the dots are ghosts; so are their names.
      if (!inFocus(spot.index)) continue;
      const text = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title;
      const textWidth = context.measureText(text).width;
      // The same rule the rail uses (`placeLabels`), over the same slots, in
      // screen pixels instead of graph units: a name has to clear every label
      // already placed *and* every dot, or it lies across something it is not
      // about.
      const box = labelSlots({
        x: spot.x,
        y: spot.y,
        clear: spot.r + 3 * scale,
        width: textWidth,
        height: height10,
      }).find(
        (candidate) =>
          candidate.x0 >= 0 &&
          candidate.x1 <= width &&
          candidate.y0 >= 0 &&
          candidate.y1 <= height &&
          !placedBoxes.some((already) => boxesOverlap(already, candidate)) &&
          !drawn.some((other) => other.index !== spot.index && circleHitsBox(other, candidate)),
      );
      if (!box) continue;
      placedBoxes.push(box);
      context.textAlign = "left";
      context.lineWidth = 3 * scale;
      context.strokeStyle = paper;
      const ty = (box.y0 + box.y1) / 2;
      context.strokeText(text, box.x0, ty);
      context.fillStyle = ink;
      context.fillText(text, box.x0, ty);
      named.push(node.title);
    }
    canvas.dataset.pages = JSON.stringify(named);
  }, [clusters, compact, graph, ready]);

  /**
   * The view that frames a domain's circle, or every circle.
   *
   * Both graphs open fitted now: domains are parted as rigid groups, so the
   * layout's extent depends on how many there are and a fixed home view
   * would crop some and float others in empty space.
   */
  const frameFor = useCallback((slug: string | null): View | null => {
    const positions = positionsRef.current;
    if (positions.length < 2) return null;
    const circles = clusterCircles(positions, clusters.radii, clusters.groups, clusters.count);
    const group = slug ? clusters.slugs.indexOf(slug) : -1;
    const chosen = circles.filter((circle) => circle.size && (group < 0 || circle.group === group));
    if (!chosen.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const circle of chosen) {
      minX = Math.min(minX, circle.x - circle.r); maxX = Math.max(maxX, circle.x + circle.r);
      minY = Math.min(minY, circle.y - circle.r); maxY = Math.max(maxY, circle.y + circle.r);
    }
    const aspect = aspectRef.current;
    // Room above for the domain names, and a margin all round. The map's
    // pills sit on their rings and need a few units. The card's names float
    // above theirs, so it keeps a strip of pixels at whatever scale it draws:
    // a few units there left its top name on the card's edge.
    const pad = compact ? 1.08 : 1.14;
    const strip = compact
      ? Math.min(0.3, (30 * graphScale(sizeRef.current.width, sizeRef.current.height, CARD_REFERENCE)) / sizeRef.current.height)
      : 0; // unmeasured, the cap
    const headroom = compact ? 0 : 6;
    const size = Math.max(18, ((maxY - minY) * pad + headroom) / (1 - strip), ((maxX - minX) / aspect) * pad);
    const lift = compact ? (size * strip) / 2 : 1.5;
    return { x: (minX + maxX) / 2 - (size * aspect) / 2, y: (minY + maxY) / 2 - size / 2 - lift, size };
  }, [clusters, compact]);
  const homeSizeRef = useRef(90);

  /** Jump, unanimated, to the frame the current focus asks for. */
  const fitView = useCallback(() => {
    const frame = frameFor(focusRef.current);
    if (!frame) return;
    viewRef.current = frame;
    homeSizeRef.current = frameFor(null)?.size ?? frame.size;
  }, [frameFor]);

  /** Every pan and zoom lands here, so the graph can never drift out of view. */
  const moveView = useCallback((next: View) => {
    viewRef.current = boundedView(next, viewRef.current, positionsRef.current, aspectRef.current);
  }, []);

  const resetFrameRef = useRef(0);
  /** Whether the view was on its fitted frame when the field last changed. */
  const fittedRef = useRef(true);
  /**
   * Lay the domains out for the field's shape.
   *
   * A fitted view alone only scales: a row of domains settled for a wide map
   * became a strip across the middle of a tall one, with the field above and
   * below it empty. So the domains are packed again as whole circles, a few
   * ways from wide to tall, and the one that can be drawn largest in this
   * field is used. The packings are made once per settled layout and a resize
   * only scores them; the pages then ease to their domain's new place.
   * The arrangement in use holds until another is clearly better, or a
   * divider dragged across the boundary would flip the map back and forth.
   */
  const arrange = useCallback((animate: boolean) => {
    const base = baseRef.current;
    if (!settledRef.current || clusters.count < 2 || clusters.count > DENSE_CLUSTERS || base.length !== clusters.groups.length * 2) return;
    const { settled, options } = clusterArrangements(base, clusters.radii, clusters.groups, clusters.count);
    const scores = options.map((circles) => (circles ? circlesFit(circles, aspectRef.current) : -Infinity));
    let best = arrangementRef.current;
    scores.forEach((score, index) => { if (score > scores[best]) best = index; });
    if (best === arrangementRef.current || scores[best] <= scores[arrangementRef.current] * 1.05) return;
    arrangementRef.current = best;
    const target = base.slice();
    for (let index = 0; index < clusters.groups.length; index += 1) {
      const group = clusters.groups[index];
      target[index * 2] += options[best]![group].x - settled[group].x;
      target[index * 2 + 1] += options[best]![group].y - settled[group].y;
    }
    cancelAnimationFrame(arrangeFrameRef.current);
    if (!animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      positionsRef.current = target;
      return;
    }
    const from = positionsRef.current.slice();
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 260);
      const eased = 1 - (1 - t) ** 3;
      const next = new Float32Array(target.length);
      for (let index = 0; index < target.length; index += 1) next[index] = from[index] + (target[index] - from[index]) * eased;
      positionsRef.current = next;
      // A fitted map stays fitted while its domains move; a moved one is left.
      if (fittedRef.current) fitView();
      draw();
      if (t < 1) arrangeFrameRef.current = requestAnimationFrame(step);
    };
    arrangeFrameRef.current = requestAnimationFrame(step);
  }, [clusters, draw, fitView]);
  useEffect(() => () => cancelAnimationFrame(arrangeFrameRef.current), []);

  // The field changes shape when the window does, and when a conversation is
  // docked or dragged wider beside the map. A view is a corner and a height,
  // so redrawing alone kept the left edge and cropped the right: half the
  // domains slid under the card's edge. A map still on its fitted frame is
  // fitted again to the new shape; one the reader has moved keeps its centre.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const home = frameFor(focusRef.current);
      const view = viewRef.current;
      const before = aspectRef.current;
      zoomBoxRef.current = null;
      sizeRef.current = {
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height),
      };
      aspectRef.current = sizeRef.current.width / sizeRef.current.height;
      if (aspectRef.current !== before) {
        const slack = (home?.size ?? 0) * 0.005;
        const fitted = home !== null &&
          Math.abs(view.x - home.x) <= slack &&
          Math.abs(view.y - home.y) <= slack &&
          Math.abs(view.size - home.size) <= slack;
        if (fitted) {
          cancelAnimationFrame(resetFrameRef.current);
          fittedRef.current = true;
          arrange(true);
          fitView();
        } else {
          fittedRef.current = false;
          arrange(true);
          moveView({ ...view, x: view.x + (view.size * (before - aspectRef.current)) / 2 });
        }
      }
      draw();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [arrange, draw, fitView, frameFor, moveView]);

  /** Ease the camera to `to`, unless motion is reduced. */
  const animateTo = useCallback((to: View | null) => {
    if (!to) return;
    cancelAnimationFrame(resetFrameRef.current);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { viewRef.current = to; draw(); return; }
    const from = { ...viewRef.current };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 420);
      const eased = 1 - (1 - t) ** 3;
      viewRef.current = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        size: from.size + (to.size - from.size) * eased,
      };
      draw();
      if (t < 1) resetFrameRef.current = requestAnimationFrame(step);
    };
    resetFrameRef.current = requestAnimationFrame(step);
  }, [draw]);
  /** Back to the view the graph opened at: every domain, fitted. */
  const resetView = useCallback(() => {
    closePreview();
    setTip(null);
    animateTo(frameFor(focusRef.current));
  }, [animateTo, closePreview, frameFor]);
  /** Zoom about the middle of the field, eased like everything else. */
  const zoomBy = useCallback((factor: number) => {
    closePreview();
    const current = viewRef.current;
    const size = Math.max(12, Math.min(homeSizeRef.current * 1.6, current.size / factor));
    const width = current.size * aspectRef.current;
    const cx = current.x + width / 2;
    const cy = current.y + current.size / 2;
    animateTo({ x: cx - (size * aspectRef.current) / 2, y: cy - size / 2, size });
  }, [animateTo, closePreview]);
  // A domain picked in the rail (or on the map) zooms the camera onto its
  // circle; clearing it eases back out to every domain.
  useEffect(() => {
    if (focusRef.current === focusDomain) return;
    focusRef.current = focusDomain;
    closePreview();
    if (settledRef.current) animateTo(frameFor(focusDomain));
    else draw();
  }, [animateTo, closePreview, draw, focusDomain, frameFor]);
  useEffect(() => () => cancelAnimationFrame(resetFrameRef.current), []);
  useEffect(() => () => dragRef.current?.stop(), []);

  useEffect(() => {
    if (!ready) return;
    const seeded = new Float32Array(graph.nodes.length * 2);
    const radii = new Float32Array(graph.nodes.length);
    graph.nodes.forEach((node, index) => {
      seeded[index * 2] = node.x;
      seeded[index * 2 + 1] = node.y;
      radii[index] = node.r;
    });
    // The settled layout is *not* seeded from here any more, and the reason is
    // what the reader sees. Seeding from cache put the simulation at its own
    // answer, so the settle had nothing left to show and the graph appeared
    // fully formed on every visit after the first — the effect this restored
    // was still missing everywhere it is most wanted, the reload. The
    // simulation is deterministic given the same seed and edges, so animating
    // from scratch each time costs about a second and lands in the same place.
    // The cache stays for the one case that cannot animate: no worker.
    const cachedLayout = (): Float32Array | null => {
      try {
        const cached = localStorage.getItem(`${LAYOUT_CACHE_PREFIX}${key}`);
        if (!cached) return null;
        const values = JSON.parse(cached) as number[];
        if (values.length !== seeded.length) return null;
        return Float32Array.from(values);
      } catch {
        // Storage is an acceleration only. Private browsing may refuse it.
        return null;
      }
    };
    positionsRef.current = seeded;
    settledRef.current = false;
    cancelAnimationFrame(arrangeFrameRef.current);
    arrangementRef.current = 0;
    fitView();
    draw(); // Initial paint is the deterministic seed, before worker settlement.
    const nodeIndex = new Map(graph.nodes.map((node, index) => [node.slug, index]));
    const edgePairs: number[] = [];
    for (const edge of graph.edges) {
      const left = nodeIndex.get(edge.from);
      const right = nodeIndex.get(edge.to);
      if (left !== undefined && right !== undefined) edgePairs.push(left, right);
    }
    const edges = new Uint32Array(edgePairs);
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/memory-graph.worker.ts", import.meta.url), { type: "module" });
    } catch {
      // No worker, so nothing will settle this. The cached layout is the whole
      // reason it is still written: it is a settled answer from a visit that
      // could run one, and it beats leaving the reader with the raw seed.
      const settled = cachedLayout();
      if (settled) positionsRef.current = settled;
      // Nothing is going to move it, so it is as settled as it will get.
      settledRef.current = true;
      baseRef.current = positionsRef.current;
      arrange(false);
      fitView();
      const frame = requestAnimationFrame(() => {
        setLayoutError(true);
        draw();
      });
      return () => cancelAnimationFrame(frame);
    }
    workerRef.current = worker;
    const statusFrame = requestAnimationFrame(() => setLayoutError(false));
    // Painted on the next animation frame rather than on arrival, and only
    // once per frame however many messages land in between: the positions live
    // in a ref, so a coalesced paint always draws the newest of them and never
    // an older one.
    let paint = 0;
    worker.onmessage = (event: MessageEvent<{ type: "frame" | "settled"; key: string; positions: ArrayBuffer }>) => {
      if (event.data.key !== key) return;
      positionsRef.current = new Float32Array(event.data.positions);
      if (event.data.type === "settled") {
        settledRef.current = true;
        rememberLayout(key, positionsRef.current);
        cancelAnimationFrame(paint);
        // The worker settles for a wide field; this one may already be tall.
        baseRef.current = positionsRef.current;
        arrangementRef.current = 0;
        arrange(false);
        fitView();
        draw();
        return;
      }
      if (paint) return;
      paint = requestAnimationFrame(() => {
        paint = 0;
        draw();
      });
    };
    worker.onerror = () => {
      setLayoutError(true);
      worker.terminate();
      workerRef.current = null;
      draw();
    };
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const positions = seeded.slice();
    const groups = clusters.groups.slice();
    worker.postMessage(
      {
        type: "layout",
        key,
        positions: positions.buffer,
        radii: radii.buffer,
        edges: edges.buffer,
        groups: groups.buffer,
        groupCount: clusters.count,
        reducedMotion,
        animate: !reducedMotion,
      },
      [positions.buffer, radii.buffer, edges.buffer, groups.buffer],
    );
    return () => {
      cancelAnimationFrame(statusFrame);
      cancelAnimationFrame(paint);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [arrange, clusters, draw, fitView, graph, key, ready, retry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      closePreview();
      const rect = canvas.getBoundingClientRect();
      if (event.ctrlKey) {
        const current = viewRef.current;
        const factor = Math.max(0.6, Math.min(1.5, Math.exp(-event.deltaY * 0.01)));
        const nextSize = Math.max(12, Math.min(homeSizeRef.current * 1.6, current.size / factor));
        const gx = current.x + (event.clientX - rect.left) * (current.size * aspectRef.current) / rect.width;
        const gy = current.y + (event.clientY - rect.top) * current.size / rect.height;
        moveView({
          x: gx - (event.clientX - rect.left) * (nextSize * aspectRef.current) / rect.width,
          y: gy - (event.clientY - rect.top) * nextSize / rect.height,
          size: nextSize,
        });
      } else {
        const current = viewRef.current;
        moveView({
          x: current.x + event.deltaX * (current.size * aspectRef.current) / rect.width,
          y: current.y + event.deltaY * current.size / rect.height,
          size: current.size,
        });
      }
      cancelAnimationFrame(resetFrameRef.current);
      draw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [closePreview, draw, moveView, ready]);

  const eventPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const panBy = (drag: NonNullable<typeof dragRef.current>, event: PointerEvent) => {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const { width, height } = sizeRef.current;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    const current = viewRef.current;
    moveView({
      x: current.x - dx * (current.size * aspectRef.current) / width,
      y: current.y - dy * current.size / height,
      size: current.size,
    });
    cancelAnimationFrame(resetFrameRef.current);
    drag.x = event.clientX;
    drag.y = event.clientY;
    closePreview();
    setTip(null);
    draw();
  };

  /** A press that never moved is a click on what is under it. */
  const pressAt = (event: PointerEvent) => {
    const point = eventPoint(event);
    const region = regionAt(point.x, point.y);
    const node = region ? null : nodeAt(point.x, point.y);
    // A click opens the page; hovering is what previews it. A domain's pill
    // zooms onto that domain.
    if (region) onFocusDomain?.(region === focusRef.current ? null : region);
    else if (node && node.openable !== false) onOpen(node.slug);
    else if (node) showPreview(node, point.x, point.y, true);
    else closePreview();
  };

  const regionAt = (x: number, y: number): string | null =>
    regionHitsRef.current.find(({ box }) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1)?.slug ?? null;

  const nodeAt = (x: number, y: number): GraphNode | null => {
    const positions = positionsRef.current;
    const view = viewRef.current;
    const { width, height } = sizeRef.current;
    const scaleX = width / (view.size * aspectRef.current);
    const scaleY = height / view.size;
    const scale = graphScale(width, height, compact ? CARD_REFERENCE : MAP_REFERENCE);
    const cellX = Math.floor(x / (GRID_SIZE * scale));
    const cellY = Math.floor(y / (GRID_SIZE * scale));
    let best: { node: GraphNode; distance: number } | null = null;
    for (let gx = cellX - 1; gx <= cellX + 1; gx += 1) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy += 1) {
        for (const index of hitGridRef.current.get(`${gx}:${gy}`) ?? []) {
          const px = (positions[index * 2] - view.x) * scaleX;
          const py = (positions[index * 2 + 1] - view.y) * scaleY;
          const distance = Math.hypot(px - x, py - y);
          const radius = Math.max(7, Math.min((6 + graph.nodes[index].r * 2.4) * scale, graph.nodes[index].r * Math.min(scaleX, scaleY)));
          if (distance <= radius && (!best || distance < best.distance)) best = { node: graph.nodes[index], distance };
        }
      }
    }
    return best?.node ?? null;
  };

  return (
    <div className={`kb-graph${compact ? " is-compact" : ""}`} data-focus={focusDomain ?? undefined}>
      <div className="kb-graph-canvas" ref={wrapRef}>
        {ready ? (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Memory map"
            onPointerDown={(event) => {
              // One pointer pans; a second finger is not a second pan.
              if (dragRef.current || (event.pointerType === "mouse" && event.button !== 0)) return;
              const drag = { x: event.clientX, y: event.clientY, moved: false, stop: (() => undefined) as () => void };
              dragRef.current = drag;
              drag.stop = followPointer(event.nativeEvent, event.currentTarget, {
                move: (move) => panBy(drag, move),
                end: (how, last) => {
                  if (dragRef.current === drag) dragRef.current = null;
                  // A pan that happened to end over a node is not a click on
                  // it, and a release heard late is no click at all.
                  if (how === "release" && !drag.moved) pressAt(last);
                },
              });
            }}
            onPointerMove={(event) => {
              // A pan is followed from the press; this is the hover.
              if (dragRef.current) return;
              const point = eventPoint(event);
              const node = nodeAt(point.x, point.y);
              event.currentTarget.style.cursor = node || regionAt(point.x, point.y) ? "pointer" : "grab";
              // Hover previews on a mouse only: on a touch screen there is
              // no hover, and a pointermove is the drag that pans.
              if (event.pointerType !== "mouse") return;
              if (compact) {
                const slug = node?.slug ?? null;
                if (hoverRef.current !== slug) {
                  hoverRef.current = slug;
                  draw();
                }
                // Placed once per node, so the bubble does not trail the pointer.
                setTip((current) => !node ? null
                  : current?.node.slug === node.slug ? current : { node, x: point.x, y: point.y, width: sizeRef.current.width || 200 });
                return;
              }
              if (node) showPreview(node, point.x, point.y, false);
              else schedulePreviewClose();
            }}
            onPointerLeave={() => {
              setTip(null);
              schedulePreviewClose();
              if (hoverRef.current) { hoverRef.current = null; draw(); }
            }}
          />
        ) : (
          // The Home card is a region of its own and grows the graph in place
          // without a caption; the full map says what it is waiting for.
          <div className="kb-graph-loading" role="status" aria-live="polite">
            <GraphMark />
            {compact ? <LoadingWords text="Loading graph" /> : <LoadingCaption text="Loading graph…" />}
          </div>
        )}
        {layoutError ? (
          <div className="kb-graph-layout-error" role="status">
            <span>The seed layout is still usable.</span>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry layout</button>
          </div>
        ) : null}
        {compact && tip ? (() => {
          // Kept inside the card: a long title near an edge is nudged inward
          // rather than clipped by the rounded frame, as in Related Memory.
          const { width } = tip;
          const estimated = Math.min(width - 24, Math.max(44, tip.node.title.length * 6));
          const x = Math.max(10 + estimated / 2, Math.min(width - 10 - estimated / 2, tip.x));
          return <div className="kb-related-tooltip" role="tooltip" style={{ left: x, top: Math.max(40, tip.y) }}>{tip.node.title}</div>;
        })() : null}
        {preview ? (
          /* Screen-pixel HTML over the canvas: its left/top are the node
             centre, making the dot the card's upper-left corner at every zoom
             level — flipped to another corner by the placement effect above
             when the card would otherwise leave the field. */
          <div
            ref={previewRef}
            className="kb-graph-preview is-expanded"
            style={{
              left: preview.x,
              top: preview.y,
              transformOrigin: `${preview.originY} ${preview.originX}`,
            }}
            onMouseEnter={cancelPreviewClose}
            onMouseLeave={schedulePreviewClose}
          >
            <div className="kb-graph-preview-inner">
              <header>
                <span className={`kb-graph-preview-kind kb-kind-${preview.node.kind}`}>
                  {KIND_LABELS[preview.node.kind]}
                </span>
              </header>
              <h3>{preview.node.title}</h3>
              <p>
                {graphPreviewExcerpt(preview.node.summary) ||
                  (preview.node.kind === "domain" ? "The pages filed under this domain." : "")}
              </p>
              <footer>
                <span>
                  {preview.node.degree} linked page{preview.node.degree === 1 ? "" : "s"}
                </span>
                {preview.node.openable === false ? null : (
                  <button type="button" onClick={() => onOpen(preview.node.slug)}>
                    Open page
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" /></svg>
                  </button>
                )}
              </footer>
            </div>
          </div>
        ) : null}
      </div>
      {!ready ? null : (
        <div ref={zoomRef} className="kb-graph-zoom" role="group" aria-label="Zoom">
          {/* The Dashboard's card keeps only the fit: the same control, in the
              same corner, as on the full map. */}
          {compact ? null : <>
          <button type="button" onClick={() => zoomBy(1.35)} aria-label="Zoom in" title="Zoom in">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.35)} aria-label="Zoom out" title="Zoom out">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>
          </button>
          </>}
          <button
            type="button"
            onClick={() => (focusRef.current && onFocusDomain ? onFocusDomain(null) : resetView())}
            aria-label="Show every domain"
            title="Show every domain"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
