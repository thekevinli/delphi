import type { Page } from "@playwright/test";

/**
 * Let go of the mouse where the page cannot hear it, then move on to (x, y).
 *
 * macOS does not always hand the window its mouse-up. Chromium learns of the
 * release from the next move, which carries no button: it ends the pointer
 * capture there (`lostpointercapture` on the element holding it) and sends no
 * `pointerup` at all. That move is sent here the way the app's own input
 * arrives, through the browser's input router, so this is Chromium only.
 * Playwright's mouse still thinks it is held; the test lets it go afterwards.
 */
export async function releaseUnheard(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.detach();
}
