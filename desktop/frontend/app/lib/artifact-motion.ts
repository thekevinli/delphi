export type EdgeRevealPoint = { x: number; y: number; radius: number; at: number };

/** Bounded samples retain source order even for right-to-left or curved paths. */
export function edgeRevealPoints(length: number, pointAt: (distance: number) => { x: number; y: number }, stroke = 2): EdgeRevealPoint[] {
  if (!Number.isFinite(length) || length <= 0 || length > 100_000) return [];
  const count = Math.min(48, Math.max(12, Math.ceil(length / 10)));
  const radius = length / (count - 1) * .8 + Math.min(20, Math.max(1, stroke));
  const points: EdgeRevealPoint[] = [];
  for (let index = 0; index < count; index++) {
    const at = index / (count - 1), point = pointAt(length * at);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    points.push({ x: point.x, y: point.y, radius, at });
  }
  return points;
}

/**
 * Serialized into the opaque document. Keep this function self-contained:
 * its only collaborator is the supplied, pure geometry sampler.
 */
function installArtifactMotion(sample: typeof edgeRevealPoints) {
  const ns = "http://www.w3.org/2000/svg";
  const selector = ".artifact-node,[data-artifact-step],[data-artifact-edge]";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const seen = new WeakSet<Element>();
  const active = new Map<Element, () => void>();
  let identity = 0, activeNodes = 0, activeEdges = 0;
  if (!reduced.matches) document.documentElement.dataset.artifactMotion = "pending";

  const phase = (element: Element) => Math.min(12, Math.max(0, Math.trunc(Number(element.getAttribute("data-artifact-step"))) || 0)) * 140;
  const visible = (element: Element) => !element.closest("[hidden]") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const fade = (element: Element) => {
    if (activeNodes >= 64) return;
    const style = getComputedStyle(element), opacity = Number(style.opacity);
    if (!Number.isFinite(opacity) || opacity === 0) return;
    // Author routing reads getBoundingClientRect() during control changes.
    // Keep node geometry stable even while an earlier entrance is playing.
    const animation = element.animate([
      { opacity: 0 },
      { opacity },
    ], { duration: 260, delay: phase(element), easing: "cubic-bezier(.2,.7,.25,1)", fill: "backwards" });
    activeNodes++;
    let cleaned = false;
    const clean = () => { if (cleaned) return; cleaned = true; activeNodes--; animation.cancel(); if (active.get(element) === clean) active.delete(element); };
    active.set(element, clean);
    void animation.finished.then(clean, clean);
  };

  const edge = (element: Element) => {
    if (activeEdges >= 24) return;
    const path = element as SVGGeometryElement;
    const svg = path.ownerSVGElement;
    // Existing author masks keep their semantics; unsupported geometry gets
    // the ordinary entrance instead of a second interpretation of its path.
    if (!svg || typeof path.getTotalLength !== "function" || path.hasAttribute("mask")) { fade(element); return; }
    let points: EdgeRevealPoint[], box: DOMRect;
    const style = getComputedStyle(path), stroke = parseFloat(style.strokeWidth) || 2;
    try { points = sample(path.getTotalLength(), distance => path.getPointAtLength(distance), stroke); box = path.getBBox(); }
    catch { fade(element); return; }
    if (!points.length || !Number.isFinite(box.width + box.height + box.x + box.y)) { fade(element); return; }
    const defs = document.createElementNS(ns, "defs");
    const mask = document.createElementNS(ns, "mask");
    const id = `delphi-artifact-edge-${++identity}`;
    mask.id = id;
    mask.dataset.artifactRuntime = "edge-mask";
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.setAttribute("maskContentUnits", "userSpaceOnUse");
    mask.style.setProperty("mask-type", "alpha", "important");
    const pad = Math.max(20, stroke * 8, points[0].radius);
    for (const [name, value] of Object.entries({ x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 })) mask.setAttribute(name, String(value));
    defs.append(mask);
    svg.prepend(defs);
    const animations: Animation[] = [];
    activeEdges++;
    const previous = path.getAttribute("mask");
    path.setAttribute("mask", `url(#${id})`);
    path.setAttribute("data-artifact-revealing", "");
    for (const point of points) {
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", String(point.x)); circle.setAttribute("cy", String(point.y)); circle.setAttribute("r", String(point.radius));
      circle.setAttribute("fill", "white"); circle.style.opacity = "0";
      // Author dot/ring rules must not restyle our reveal geometry. Opacity
      // remains animatable; its inline base already wins over ordinary CSS.
      for (const [name, value] of Object.entries({
        fill: "white", stroke: "none", "fill-opacity": "1", display: "inline", visibility: "visible",
        transform: "none", filter: "none", "clip-path": "none", mask: "none", animation: "none", transition: "none",
        cx: `${point.x}px`, cy: `${point.y}px`, r: `${point.radius}px`,
      })) circle.style.setProperty(name, value, "important");
      mask.append(circle);
      animations.push(circle.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 55, delay: phase(path) + point.at * 365, easing: "ease-out", fill: "forwards" }));
    }
    let cleaned = false;
    const clean = () => {
      if (cleaned) return;
      cleaned = true;
      activeEdges--;
      for (const animation of animations) animation.cancel();
      if (path.getAttribute("mask") === `url(#${id})`) {
        if (previous === null) path.removeAttribute("mask"); else path.setAttribute("mask", previous);
      }
      path.removeAttribute("data-artifact-revealing");
      defs.remove();
      if (active.get(element) === clean) active.delete(element);
    };
    active.set(element, clean);
    // Removing the temporary mask restores the complete stroke and markers,
    // including arrowheads beyond getBBox(). Only mask opacity is animated.
    void Promise.all(animations.map(animation => animation.finished)).then(clean, clean);
  };

  const elements = (scope: Element | Document) => [
    ...(scope instanceof Element && scope.matches(selector) ? [scope] : []),
    ...scope.querySelectorAll(selector),
  ];
  const run = (scope: Element | Document, replay = false) => {
    const items = elements(scope);
    if (replay) {
      for (const item of items) { active.get(item)?.(); seen.delete(item); }
    }
    if (reduced.matches) return;
    let nodes = 0, edges = 0;
    for (const item of items) {
      if (seen.has(item) || !visible(item)) continue;
      seen.add(item);
      if (item.hasAttribute("data-artifact-edge")) { if (edges++ < 24) edge(item); }
      else if (nodes++ < 64) fade(item);
    }
  };
  Object.defineProperty(window, "DelphiArtifact", { value: Object.freeze({
    replay(scope?: Element) { run(scope instanceof Element ? scope : document, true); },
  }), writable: false, configurable: false });

  addEventListener("DOMContentLoaded", () => {
    // Remove the first-paint guard and install backward-filled animations in
    // one task, so neither complete arrows nor hidden final content flashes.
    document.documentElement.removeAttribute("data-artifact-motion");
    try { run(document); } catch { for (const clean of [...active.values()]) clean(); }
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && !node.closest("defs")) run(node);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, { once: true });
  reduced.addEventListener("change", () => {
    if (reduced.matches) for (const clean of [...active.values()]) clean();
  });
}

export function artifactMotionBootstrap(): string {
  return `(${installArtifactMotion.toString()})(${edgeRevealPoints.toString()});`;
}
