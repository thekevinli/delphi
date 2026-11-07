/**
 * The journey's documents: PDFs built here, two pages of selectable text each,
 * written for this test. No third-party paper is uploaded. The fixture
 * provider files a document by its name, never by its words, so the words only
 * have to be text the backend can extract and cite by page.
 */

const PAGES = [
  [
    "Notes on reusing a prompt prefix",
    "A request that repeats the opening of an earlier one can skip that work.",
    "Only an exact token match counts; a paraphrase of the opening does not.",
    "Put the material that stays the same first and the changing question last.",
  ],
  [
    "A small comparison",
    "Twenty requests with a fixed opening against twenty with a shuffled one.",
    "The fixed opening answered sooner in this one setup.",
    "One setup is not a general rule; repeat it before relying on it.",
  ],
];

/** A two-page PDF whose first page is headed `label`. No title in its metadata: it keeps the name it is uploaded under. */
export function notePdf(label: string): Uint8Array<ArrayBuffer> {
  const pages = PAGES.map((lines, index) => index ? lines : [`Study note ${label}`, ...lines]);
  for (const line of pages.flat()) {
    // Kept out of PDF string syntax rather than escaped.
    if (/[()\\]|[^\x20-\x7e]/.test(line)) throw new Error(`Not a plain line: ${line}`);
  }
  const font = 3 + 2 * pages.length;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + 2 * index} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = `BT /F1 13 Tf 56 730 Td 22 TL ${lines.map((line) => `(${line}) Tj`).join(" T* ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + 2 * index} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
