export const PAGE_ZOOM_STEPS = [50, 75, 100, 110, 125, 150, 200] as const;

export function stepPageZoom(current: number, direction: number): number {
  const index = PAGE_ZOOM_STEPS.indexOf(current as typeof PAGE_ZOOM_STEPS[number]);
  return PAGE_ZOOM_STEPS[Math.max(0, Math.min(PAGE_ZOOM_STEPS.length - 1, index + direction))];
}

// Shrink the iframe's layout viewport while enlarging its rendered CSS pixels.
// Unlike pinch magnification, this reflows text and responsive page layouts.
export function pageFrameLayout(width: number, height: number, renderWidth: number | undefined, percent: number) {
  const baseline = renderWidth || width;
  const fit = Math.min(1, width / baseline);
  const scale = fit * percent / 100;
  return { width: baseline * 100 / percent, height: height / scale, transform: `scale(${scale})`, transformOrigin: "top left" };
}
