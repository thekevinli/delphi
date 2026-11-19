import { isWebPaper, isWebPdf, type Paper } from "./api.ts";

/**
 * Which of the two file marks a document wears, and the word that goes with it.
 *
 * Read from the stored source type, never from the title: an arXiv id in a
 * title says nothing about whether the reader saved the abstract page or the
 * PDF. A linked PDF is stored through the web-document contract but is read as
 * a PDF, so it wears the PDF mark; a paper stored before web documents existed
 * carries no kind at all and is a PDF.
 */
export type PaperMark = "web" | "pdf";

export function paperMark(paper: Paper): PaperMark {
  return isWebPaper(paper) && !isWebPdf(paper) ? "web" : "pdf";
}

export const PAPER_MARK_LABEL: Record<PaperMark, string> = {
  web: "Web page",
  pdf: "PDF",
};
