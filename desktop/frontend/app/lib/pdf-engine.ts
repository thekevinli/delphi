export type PdfModule = typeof import("pdfjs-dist");
export type PdfDocument = Awaited<ReturnType<PdfModule["getDocument"]>>["promise"] extends Promise<
  infer T
>
  ? T
  : never;

/**
 * The PDF engine is a large dynamic import plus a worker, and it used to load
 * only when the first paper was opened — which is what made the first paper of
 * a session take seconds to become selectable while later ones took a few
 * hundred milliseconds. Kept as a module-level promise so it is fetched once
 * and can be warmed while the reader is still choosing a paper.
 *
 * It lives here rather than in `PdfViewer` because the locator index needs the
 * same engine for documents that are not on screen, and a second worker setup
 * on one page would be a real hazard rather than a tidiness question. Note that
 * this shares the *module* only: a `PDFDocumentProxy` is owned by whoever
 * called `getDocument`, and `locator-index` is explicit about which of the two
 * owns each one.
 */
let pdfEngine: Promise<PdfModule> | null = null;

export function loadPdfEngine(): Promise<PdfModule> {
  if (pdfEngine) return pdfEngine;
  // WebKit gained async iteration for ReadableStream later than the stream
  // primitive itself. PDF.js uses `for await` for text extraction, so provide
  // the missing protocol without replacing the browser's stream implementation.
  const streamPrototype = ReadableStream.prototype as ReadableStream & {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  if (!streamPrototype[Symbol.asyncIterator]) {
    Object.defineProperty(streamPrototype, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: function streamIterator(this: ReadableStream) {
        const reader = this.getReader();
        return {
          next: () => reader.read(),
          return: async () => {
            await reader.cancel();
            reader.releaseLock();
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    });
  }
  pdfEngine = import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return module;
  });
  return pdfEngine;
}
