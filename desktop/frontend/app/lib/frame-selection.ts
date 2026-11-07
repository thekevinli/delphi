/** Where the Reply pill sits, in the parent's viewport.

 * The framed page reports a selection in its own CSS pixels. A stored DOM is
 * laid out at 1512px and then `transform: scale`d to the pane, so those pixels
 * are not the ones on screen. `getBoundingClientRect` on the iframe is already
 * the visual box; `offsetWidth` is still the layout width. Their ratio is the
 * scale. Live pages have no transform and the ratio is 1, so the pill sits
 * where it always did.
 */
export function selectionMenuPoint(
  frame: { left: number; top: number; width: number },
  layoutWidth: number,
  rect: { x: number; y: number; w: number },
): { x: number; y: number } {
  const scale = layoutWidth > 0 ? frame.width / layoutWidth : 1;
  return {
    x: frame.left + (rect.x + rect.w / 2) * scale,
    y: frame.top + rect.y * scale - 10,
  };
}
