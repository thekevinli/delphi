import { test, expect, type Page } from "@playwright/test";

/**
 * Following a citation across two documents and within one, end to end: the
 * answer is parsed into links, each link is routed by what it names, by the
 * prose around it, and by the locator index reading both PDFs, and the reader
 * opens the chosen document with the cited caption boxed.
 *
 * Both papers print a "Table 3", so a nameless `(Table 3, p. 2)` is decided by
 * the sentence it sits in and never by whichever table is found first.
 *
 * The last two are written as models write them: a title in italics that
 * carries its arXiv id in parentheses, and a locator in bold. Each markup run
 * is an element of its own, and on 2026-10-17 a live answer cited that way
 * showed no links at all.
 */

/** A Letter PDF with one page per entry, each a column of text lines. */
function pdf(pages: string[][]) {
  const escape = (text: string) => text.replace(/[\\()]/g, "\\$&");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pages.entries()) {
    const text = lines.map((line, row) => `BT /F1 12 Tf 72 ${720 - row * 18} Td (${escape(line)}) Tj ET`).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(at => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

const prose = "Mixture models route tokens to experts, and the router decides both accuracy and cost.";
const files: Record<string, string> = {
  sparse: pdf([
    ["SparseRoute: Sparse Routing at Scale", prose],
    ["3 Results", prose, "Table 3: Routing accuracy of SparseRoute.", "top-1 88%   top-2 91%"],
    ["4 Discussion", prose],
  ]),
  dense: pdf([
    ["DenseBase: Dense Baselines Revisited", prose],
    ["3 Results", prose, "Table 3: Dense model accuracy.", "dense 84%"],
    ["Appendix", prose, "Table 5: Ablation of the appendix setting.", "A 83%   B 83%"],
  ]),
};

const answer = [
  "SparseRoute peaks at 91% while DenseBase's ablation is flat (SparseRoute, Table 3, p. 2; DenseBase, Table 5, p. 3).",
  "DenseBase reports 84% for its dense model (Table 3, p. 2).",
  "Read side by side (SparseRoute, Table 3, p. 2), (DenseBase, Table 3, p. 2).",
  "The router matters most at top-2 (Table 3, p. 2).",
  "The flat ablation is the appendix one (Table 5, p. 3).",
  "As a model writes it (*DenseBase: Dense Baselines Revisited (2610.00002v1)*, Table 5, p. 3).",
  "And with the table in bold (SparseRoute, **Table 3**, p. 2).",
].join("\n\n");

async function setup(page: Page) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/test/answer") return route.fulfill({ json: { answer } });
    const file = /\/papers\/(\w+)\/file$/.exec(url.pathname)?.[1];
    if (file && files[file]) return route.fulfill({ contentType: "application/pdf", body: files[file] });
    return route.fulfill({ status: 404, json: { detail: `Unexpected test request ${url.pathname}` } });
  });
  await page.goto("/tests/browser/harness.html?citations");
  await expect(page.locator(".citation-link")).toHaveCount(9);
  await expect(page.locator(".pdf-page").first()).toBeVisible();
}

/** Where the reader landed: which document, which page, and the text boxed. */
function landing(page: Page) {
  return page.evaluate(() => {
    const guide = document.querySelector(".pdf-guide");
    if (!guide || guide.classList.contains("pdf-guide-page")) return null;
    const sheet = guide.closest(".pdf-page");
    const box = guide.getBoundingClientRect();
    const boxed = [...(sheet?.querySelectorAll(".text-layer span") ?? [])]
      .filter(span => {
        const r = span.getBoundingClientRect();
        return r.width > 0 && r.top < box.bottom && r.bottom > box.top && r.left < box.right && r.right > box.left;
      })
      .map(span => span.textContent)
      .join(" ");
    return `${document.querySelector('[data-testid="open"]')?.textContent} p.${sheet?.getAttribute("data-page")}: ${boxed}`;
  });
}

const cases: Array<[link: number, label: string, lands: RegExp]> = [
  // Named, and split on `;` into one link per document.
  [0, "SparseRoute, Table 3, p. 2", /^sparse p\.2: .*Table 3: Routing accuracy of SparseRoute/],
  [1, "DenseBase, Table 5, p. 3", /^dense p\.3: .*Table 5: Ablation of the appendix setting/],
  // Nameless, placed by the sentence that names DenseBase, though the paper on
  // screen has a Table 3 on the same page.
  [2, "Table 3, p. 2", /^dense p\.2: .*Table 3: Dense model accuracy/],
  // Named, in separate parentheticals.
  [3, "SparseRoute, Table 3, p. 2", /^sparse p\.2: .*Table 3: Routing accuracy of SparseRoute/],
  [4, "DenseBase, Table 3, p. 2", /^dense p\.2: .*Table 3: Dense model accuracy/],
  // Nameless and unplaced: the paper on screen has it, so it stays.
  [5, "Table 3, p. 2", /^sparse p\.2: .*Table 3: Routing accuracy of SparseRoute/],
  // Nameless and unplaced: the paper on screen lacks it, so the index sends it
  // to the other paper the answer mentions.
  [6, "Table 5, p. 3", /^dense p\.3: .*Table 5: Ablation of the appendix setting/],
  // Marked up: the markup comes off and the citation is followed as any other.
  [7, "DenseBase: Dense Baselines Revisited (2610.00002v1), Table 5, p. 3", /^dense p\.3: .*Table 5: Ablation of the appendix setting/],
  [8, "SparseRoute, Table 3, p. 2", /^sparse p\.2: .*Table 3: Routing accuracy of SparseRoute/],
];

for (const [link, label, lands] of cases) {
  test(`citation ${link + 1}, (${label}), lands on its own document's caption`, async ({ page }) => {
    await setup(page);
    const citation = page.locator(".citation-link").nth(link);
    await expect(citation).toHaveText(new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`));
    await citation.click();
    await expect.poll(() => landing(page), { intervals: [100], timeout: 15_000 }).toMatch(lands);
  });
}
