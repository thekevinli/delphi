import type { ViewportSection } from "./api.ts";

/**
 * Where a citation into captured viewport evidence should land.
 *
 * Evidence captured on the document's own page is a copy of what the reader
 * sees, so the citation belongs on the live page, scrolled to the passage it
 * names; the captured text view — "Passage 1, Passage 2…" — is only the
 * honest answer when the evidence came from another page the frame had
 * navigated to, which the reader could not otherwise see again.
 */
export function evidencePassageQuote(
  evidence: { kind: string; url: string; document?: { sections: ViewportSection[] } },
  documentUrl: string | undefined,
  anchor: string | null | undefined,
): { quote: string; lead: string } | null {
  if (evidence.kind !== "html" || !anchor || !documentUrl || !samePage(evidence.url, documentUrl)) return null;
  const passage = evidence.document?.sections.find((section) => section.anchor === anchor);
  const quote = passage?.markdown.replace(/\s+/g, " ").trim() ?? "";
  if (quote.length < 3) return null;
  return { quote, lead: openingPhrase(quote) };
}

/**
 * The passage is pointed at whole: it was read from the page's own text nodes
 * and the frame matches across inline markup, so a link or an emphasis inside
 * it is no obstacle. Only its first six words were highlighted once, which read
 * as a random fragment rather than the evidence. The opening phrase is kept as
 * the fallback for a live page whose paragraph has changed since the capture.
 */
function openingPhrase(text: string): string {
  return text.split(" ").slice(0, 6).join(" ").slice(0, 60).trim();
}

function samePage(a: string, b: string): boolean {
  const key = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return value;
    }
  };
  return key(a) === key(b);
}
