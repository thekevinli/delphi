/**
 * One pressed pointer, followed until it is let go.
 *
 * Every drag here used to end on the pointerup its own element heard, trusting
 * pointer capture to route each ending there. Capture does not promise that,
 * and each way it falls short left a drag running under a mouse no longer
 * pressed: a card in the air, a divider still resizing, a map still panning.
 *
 * - A release the window never hears (macOS keeps a mouse-up from it now and
 *   then) sends no pointerup at all. Chromium learns of it from the next move,
 *   which carries no button, and drops the capture: `lostpointercapture`.
 * - A capture can be dropped before it is ever taken, when the move after the
 *   press already carries no button. Nothing is lost then, so nothing says so,
 *   and the pointerup lands on whatever is under the pointer.
 *
 * So the gesture follows the pointer, not the element. A release or a cancel
 * heard anywhere in the window ends it, and so does the capture's loss or a
 * move that says no button is held: one fact heard four ways, and the first
 * to arrive ends it, once. Capture is still asked for, but only to keep moves
 * coming while the pointer is outside the window.
 */

/** How the pointer was let go. `unheard` is a release the page learned of late. */
export type PointerEnd = "release" | "cancel" | "unheard";

export interface PointerFollower {
  move?: (event: PointerEvent) => void;
  end: (how: PointerEnd, event: PointerEvent) => void;
}

/** Follows `press`'s pointer until it is let go; the returned function stops early. */
export function followPointer(press: PointerEvent, holder: Element, on: PointerFollower): () => void {
  const id = press.pointerId;
  let following = true;
  const ours = (event: Event): event is PointerEvent =>
    following && (event as PointerEvent).pointerId === id;
  const finish = (how: PointerEnd, event: PointerEvent) => {
    stop();
    on.end(how, event);
  };
  const move = (event: Event) => {
    if (!ours(event)) return;
    if (event.buttons === 0) finish("unheard", event);
    else on.move?.(event);
  };
  const release = (event: Event) => { if (ours(event)) finish("release", event); };
  const cancel = (event: Event) => { if (ours(event)) finish("cancel", event); };
  const lost = (event: Event) => { if (ours(event)) finish("unheard", event); };
  function stop() {
    if (!following) return;
    following = false;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", cancel, true);
    holder.removeEventListener("lostpointercapture", lost);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", cancel, true);
  holder.addEventListener("lostpointercapture", lost);
  try {
    holder.setPointerCapture(id);
  } catch {
    // A pointer the browser no longer counts as pressed; the window still hears it.
  }
  return stop;
}

/**
 * Lets the click that follows a drop pass by unanswered.
 *
 * A drop on the row it began on is followed by a click there, in the same
 * input task as the release; a drop anywhere else, or one the page never
 * heard, is followed by none. So the flag is lowered once that task is over,
 * rather than waiting for a click that may never come and then swallowing the
 * reader's next real one.
 */
export function suppressClickAfterDrop(flag: { current: boolean }) {
  window.setTimeout(() => { flag.current = false; }, 0);
}
