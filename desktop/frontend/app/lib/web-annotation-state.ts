/** Validation at the boundary with a scriptable, untrusted webpage. */
export function annotationBox(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.w, rect.h].every(n => typeof n === "number" && Number.isFinite(n))) return null;
  if ((rect.w as number) < 0 || (rect.h as number) < 0) return null;
  return { x: rect.x as number, y: rect.y as number, w: rect.w as number, h: rect.h as number };
}

/** A selection the frame can capture on request, named by the frame's own serial for it. */
export function annotationSelection(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const { selection } = value as Record<string, number>;
  if (!Number.isSafeInteger(selection) || selection < 0) return undefined;
  return { selection };
}

function pageTexts(value: unknown) {
  if (!Array.isArray(value) || value.length > 100000) return null;
  let size = 0;
  for (const text of value) {
    if (typeof text !== "string" || (size += text.length + 1) > 600000) return null;
  }
  return value as string[];
}

export function annotationIndex(value: Record<string, unknown>) {
  const texts = pageTexts(value.texts);
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !texts) return null;
  return { generation: value.generation as number, texts, complete: value.complete === true };
}

/** The frame's answer to a capture: the page's text and the selection in it, or why not. */
export function annotationCapture(value: Record<string, unknown>) {
  if (typeof value.request !== "string" || value.request.length > 64) return null;
  if (typeof value.error === "string") return { request: value.request, error: value.error.slice(0, 200) };
  const texts = pageTexts(value.texts);
  const { start, end } = value as Record<string, number>;
  if (!texts || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 20000) return null;
  return { request: value.request, texts, start, end };
}

/** A page copy the frame serialised for the saved copy, as the backend will be sent it. */
export type PageCopy = { html: string; width: number; url: string };

/**
 * The frame's answer to a page capture, or null. Held to the limits the backend
 * enforces again: `maxBytes` of UTF-8, a layout width the reader could have had
 * (kept in step with `MIN_PAGE_WIDTH`/`MAX_PAGE_WIDTH` in `web_revision.py`),
 * and a web address. Nothing here makes the markup trustworthy; the backend
 * sanitises it regardless.
 */
export function pageCopy(value: Record<string, unknown>, maxBytes: number): PageCopy | null {
  const { html, width, url } = value;
  if (typeof html !== "string" || !html || html.length > maxBytes) return null;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 320 || width > 10000) return null;
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  if (html.length * 3 > maxBytes && new TextEncoder().encode(html).length > maxBytes) return null;
  return { html, width, url };
}

/** A late initial/retry read must not undo a write performed while it ran. */
export function mergeAnnotationRead<T>(current: T[], incoming: T[], key: (item: T) => string, deleted: Set<string>) {
  const present = new Set(current.map(key));
  return [...current, ...incoming.filter(item => !present.has(key(item)) && !deleted.has(key(item)))];
}
