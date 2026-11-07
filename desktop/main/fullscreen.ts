/**
 * Full-screen state, told to the page.
 *
 * The header leaves room on its left for the traffic lights, and in full screen
 * they are gone. Nothing the renderer can see says so: `display-mode:
 * fullscreen` does not match and the viewport still stops short of the screen,
 * so the main process stamps the state on the root element. The window has no
 * preload; this is a one-line script, not a bridge.
 */

/** Present on `<html>` while the window is full screen; the stylesheet keys off it. */
export const FULL_SCREEN_ATTRIBUTE = "data-fullscreen";

export function fullScreenScript(fullScreen: boolean): string {
  return `document.documentElement.toggleAttribute(${JSON.stringify(FULL_SCREEN_ATTRIBUTE)}, ${fullScreen})`;
}
