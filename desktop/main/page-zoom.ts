/** Route keyboard zoom to the reader even when a sandboxed frame has focus. */
export function pageZoomDirection(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean }): number | null {
  if (input.type !== "keyDown" || !input.meta || input.control || input.alt) return null;
  if (input.key === "+" || input.key === "=") return 1;
  if (input.key === "-") return -1;
  if (input.key === "0") return 0;
  return null;
}

export function pageZoomScript(direction: number): string {
  return `window.dispatchEvent(new CustomEvent("delphi-page-zoom", { detail: ${direction === 0 ? 0 : direction === 1 ? 1 : -1} }))`;
}
