export type FindResult = { total: number; index: number };

/** Self-contained so the desktop can run the same search inside the sandboxed page.
 * Returns counts only; never returns document text to the host.
 */
export function findDocumentText(query: string, index: number, selector = "body"): FindResult {
  const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  registry.delete("delphi-find");
  registry.delete("delphi-find-active");
  const root = document.querySelector(selector);
  if (!root || !query.trim()) return { total: 0, index: 0 };
  if (!document.getElementById("delphi-find-style")) {
    const style = document.createElement("style");
    style.id = "delphi-find-style";
    style.textContent = "::highlight(delphi-find){background:#ffe2a0;color:#342414}::highlight(delphi-find-active){background:#ff9b4b;color:#24180f}";
    // PDF glyphs are already drawn on the canvas. Keep the same highlight hues,
    // translucent over that canvas, without painting the text layer's font.
    style.textContent += ".text-layer ::highlight(delphi-find){background:#ffe2a080;color:transparent}.text-layer ::highlight(delphi-find-active){background:#ff9b4b80;color:transparent}";
    document.head.append(style);
  }
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR";
    if (node.nodeType !== Node.TEXT_NODE && !isBreak) continue;
    const parent = isBreak ? node as Element : node.parentElement;
    if (!parent || parent.closest("script,style,noscript,textarea,input,[hidden],[aria-hidden=true]")) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || !parent.getClientRects().length) continue;
    // A visible <br> separates words just like whitespace, but has no text node.
    if (isBreak) { text += " "; continue; }
    const value = node.textContent || "";
    let block: Element = parent;
    while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    if (nodes.length && (selector.includes("text-layer") || block !== previousBlock)) text += " ";
    previousBlock = block;
    nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  // Collapse whitespace with an offset map, preserving cross-span matches.
  let normalized = "";
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = /\s/.test(text[i]) ? " " : text[i].toLowerCase();
    if (char === " " && normalized.endsWith(" ")) continue;
    for (const part of char) { normalized += part; offsets.push(i); }
  }
  const ranges: Range[] = [];
  let offset = 0;
  while ((offset = normalized.indexOf(needle, offset)) !== -1) {
    const start = offsets[offset], end = offsets[offset + needle.length - 1] + 1;
    const first = nodes.find(item => item.end > start);
    const last = nodes.find(item => item.end >= end);
    if (first && last) {
      const range = document.createRange();
      range.setStart(first.node, Math.max(0, start - first.start));
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
    offset += needle.length;
  }
  if (!ranges.length) return { total: 0, index: 0 };
  const active = ((index % ranges.length) + ranges.length) % ranges.length;
  const HighlightClass = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  registry.set("delphi-find", new HighlightClass(...ranges));
  registry.set("delphi-find-active", new HighlightClass(ranges[active]));
  ranges[active].startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  return { total: ranges.length, index: active };
}
