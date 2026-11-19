// Construct a small valid PDF locally: the contract suite has no upstream
// fixtures, Python test packages, provider credentials, or deployment files.
export function samplePdf(pages = 1): Uint8Array<ArrayBuffer> {
  // Each page's text fits its 300pt width, so each extracts as its own.
  const text = (page: number) => `BT /F1 18 Tf 40 150 Td (${page > 1 ? `Desktop contract page ${page}` : "Desktop contract document"}) Tj ET`;
  const pageIds = Array.from({ length: pages }, (_, index) => 4 + 2 * index);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageIds.flatMap((id, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${text(index + 1).length} >>\nstream\n${text(index + 1)}\nendstream`,
    ]),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
