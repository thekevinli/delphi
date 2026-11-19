import { PAPER_MARK_LABEL, type PaperMark } from "../lib/paper-kind";

/**
 * The two file marks: a web page and a PDF.
 *
 * Shape, fill and colour all differ so a skim down a list tells them apart —
 * the web page is a wide browser window with a solid top bar, the PDF a tall
 * folded sheet in a lighter outline. One component for the Settings Projects
 * pane and the `@` menu, which list the same documents, so a document wears
 * the same mark in both; the library still draws its own globe and sheet.
 * Colour comes from `currentColor`: the stylesheet gives each mark its ink,
 * and each list says which of its rows takes the stronger one.
 *
 * `labelled` is for a list that does not also say the kind in words.
 */
export function KindMark({
  kind,
  labelled = false,
}: {
  kind: PaperMark;
  labelled?: boolean;
}) {
  const a11y = labelled
    ? ({ role: "img", "aria-label": PAPER_MARK_LABEL[kind] } as const)
    : ({ "aria-hidden": true } as const);
  return kind === "web" ? (
    <svg className="kind-mark is-web" viewBox="0 0 16 14" fill="none" {...a11y}>
      <rect x="1" y="2" width="14" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1 4.6V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v.6z" fill="currentColor" />
      <path d="M1 4.6h14" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="3.3" r=".6" fill="#fff" />
      <circle cx="5.3" cy="3.3" r=".6" fill="#fff" />
    </svg>
  ) : (
    <svg
      className="kind-mark is-pdf"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      {...a11y}
    >
      <path d="M3.2 1.6h5l2.6 2.6v8.2H3.2z" />
      <path d="M8.2 1.6v2.6h2.6" />
      <path d="M5 7.4h4M5 9.6h2.6" strokeLinecap="round" />
    </svg>
  );
}
