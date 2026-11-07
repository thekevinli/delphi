import { useState } from "react";
import { MentionField, type MentionTab } from "../../app/components/chat/MentionField";
import type { ChatImage, Paper } from "../../app/lib/api";

/** The `@` menu over a fixed library, for `?mention`. `&empty` and `&no-images`
 *  take the documents and the images away; `&general` is the one-tab menu. */
const paper = (id: string, title: string, kind: "pdf" | "web", filename = `${id}.${kind === "web" ? "html" : "pdf"}`): Paper =>
  ({ id, title, slug: id, filename, pages: 1, tokens: 1, kind });
const PAPERS = [
  paper("clm", "Context Language Models - Meta (2609.37725v1)", "pdf"),
  paper("sdft", "SDFT: Self-Distillation Enables Continual Learning", "web"),
  paper("opd", "On-Policy Distillation", "web"),
  paper("workspace", "A global workspace in language models", "web"),
  paper("harness", "The ultimate guide to multi-harness RL", "web"),
  // Stored through the web contract, read as a PDF.
  paper("linked", "A linked PDF with a long title that has to end in an ellipsis rather than wrap", "web", "linked.pdf"),
];
const image = (number: number, expiresAt: string): ChatImage => ({
  id: `image-${number}`, number, width: 56, height: 40, sourceBytes: 1, normalizedBytes: 1,
  sourceFormat: "png", createdAt: "", expiresAt, used: true,
});
const IMAGES = [image(1, "later"), image(2, "soon")];
const thumb = (id: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="40"><rect width="56" height="40" fill="${id === "image-1" ? "#D9C8C2" : "#F4D9A8"}"/></svg>`)}`;
export default function MentionHarness() {
  const mode = new URLSearchParams(location.search);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const tabs: MentionTab[] = mode.has("general") ? ["images"] : ["papers", "images"];
  const papers = mode.has("empty") || mode.has("general") ? [] : PAPERS;
  const images = mode.has("no-images") ? [] : IMAGES;
  return <div style={{ width: Number(mode.get("width") ?? 720), margin: "420px 40px 0" }}>
    <form className="composer" onSubmit={event => event.preventDefault()}>
      <MentionField papers={papers} images={images} paintPapers={papers} paintImages={images} tabs={tabs}
        imageUrl={thumb} placeholder="Ask anything" autoFocus
        onDraftChange={setDraft} onPaperMention={item => setPicked(all => [...all, item.id])}
        onImageMention={item => setPicked(all => [...all, item.id])} onSubmit={() => setPicked(all => [...all, "submit"])}
        expiryNote={expiresAt => expiresAt === "soon" ? "Expires in 2 days" : null} />
    </form>
    <output data-testid="draft">{draft}</output><output data-testid="picked">{picked.join(",")}</output>
  </div>;
}
