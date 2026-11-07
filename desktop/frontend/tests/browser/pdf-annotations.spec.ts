import { test, expect, type Page } from "@playwright/test";
import type { Highlight, Note } from "../../app/lib/api";

/** One Letter page with one line of text, xref offsets computed rather than hand-counted. */
function pdf() {
  const text = "BT /F1 24 Tf 72 700 Td (Overlapping strokes share one line of text.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

// The text's line, in normalised page coordinates: two records over one band.
const line = { y: 0.09, h: 0.04 };
const seeded: Highlight[] = [
  { id: "h1", type: "pdf", page: 1, color: "amber", text: "Overlapping strokes share one line", rects: [{ x: 0.1, w: 0.6, ...line }] } as Highlight,
  { id: "h2", type: "pdf", page: 1, color: "amber", text: "strokes share", rects: [{ x: 0.3, w: 0.2, ...line }] } as Highlight,
];

async function setup(page: Page, anchorY = line.y) {
  const state = {
    highlights: structuredClone(seeded).map(highlight => ({ ...highlight, rects: highlight.rects?.map(rect => ({ ...rect, y: anchorY })) })),
    notes: [{ id: "n1", highlightId: "h1", page: 1, anchorY, quotedText: seeded[0].text, body: "First thought", createdAt: "now", updatedAt: "now", filedAt: null }] as Note[],
    /** A save the store refuses, as a full disk or a lost backend would. */
    refuseSave: false,
    saves: 0,
  };
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname.endsWith("/file")) return route.fulfill({ contentType: "application/pdf", body: pdf() });
    if (url.pathname.endsWith("/highlights")) return json(state.highlights);
    if (url.pathname.includes("/highlights/")) {
      const id = url.pathname.split("/").at(-1)!;
      state.highlights = state.highlights.filter(h => h.id !== id); state.notes = state.notes.filter(n => n.highlightId !== id);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/notes")) {
      if (req.method() === "GET") return json(state.notes);
      state.saves += 1;
      if (state.refuseSave) return json({ detail: "The store refused the note." }, 500);
      const body = req.postDataJSON();
      const saved = { ...body, id: `n-${body.highlightId}`, createdAt: "now", updatedAt: "now", filedAt: null };
      state.notes = [...state.notes.filter(n => n.highlightId !== saved.highlightId), saved];
      return json(saved);
    }
    return json({ detail: `Unexpected test request ${url.pathname}` }, 404);
  });
  await page.goto("/tests/browser/harness.html?pdf");
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  return state;
}

test("the PDF list sits in the reader toolbar and answers a click on overlapping strokes", async ({ page }) => {
  await setup(page);
  const trigger = page.locator(".reader-actions").getByRole("button", { name: "Annotations (2)" });
  await expect(trigger).toBeVisible();
  // Inside both records, so the click cannot say which one it meant. The page
  // can still be settling its layout when the band first shows, so the boxes
  // are measured again on each attempt rather than trusted from the first.
  await expect(async () => {
    const band = await page.locator(".pdf-highlight").first().boundingBox();
    const frame = await page.locator(".pdf-page").first().boundingBox();
    await page.mouse.click(frame!.x + frame!.width * 0.4, band!.y + band!.height / 2);
    await expect(page.locator(".annotation-selected")).toHaveCount(2, { timeout: 1000 });
  }).toPass();
});

test("a note opened from the list keeps what the open card held, and saves where it was written", async ({ page }) => {
  const state = await setup(page);
  const trigger = page.getByRole("button", { name: "Annotations (2)" });
  await trigger.click();
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toContainText("First thought");
  await editor.fill("Revised thought");
  await trigger.click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect.poll(() => state.notes.find(n => n.highlightId === "h1")?.body).toBe("Revised thought");
  await expect(editor).toHaveCount(1);
  await editor.fill("Second thought");
  await editor.press("Enter");
  await expect.poll(() => state.notes.find(n => n.highlightId === "h2")?.body).toBe("Second thought");
});

test("a note that cannot be saved says so in the window's toast, and the draft stays open", async ({ page }) => {
  const state = await setup(page);
  state.refuseSave = true;
  await page.getByRole("button", { name: "Annotations (2)" }).click();
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("Unsaved thought");
  await editor.press("Enter");
  const toast = page.locator(".toast.toast-error", { hasText: "The store refused the note." });
  await expect(toast).toBeVisible();
  // On the window, at its foot, rather than in a box over the page.
  const viewport = page.viewportSize()!;
  const box = (await toast.boundingBox())!;
  expect(box.y).toBeGreaterThan(viewport.height * 0.75);
  await expect(page.locator(".annotation-error")).toHaveCount(0);
  await expect(editor).toContainText("Unsaved thought");
  const tries = state.saves;
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);
  // Dismissing is not a click away from the note: nothing is sent again, and the draft stays.
  await page.waitForTimeout(1500);
  expect(state.saves).toBe(tries);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(editor).toContainText("Unsaved thought");
});

test("hover peeks are transient and independent of the clicked note", async ({ page }) => {
  const state = await setup(page);
  state.highlights[1].rects = [{ x: 0.1, w: 0.5, y: 0.4, h: 0.04 }];
  state.notes.push({ ...state.notes[0], id: "n2", highlightId: "h2", anchorY: 0.4, body: "A second **formatted** thought with `code` and enough text to need a compact two-line preview instead of opening another full card." });
  await page.reload();
  const first = page.getByRole("button", { name: "Note: First thought", exact: true });
  const second = page.getByRole("button", { name: /^Note: A second/ });
  await first.hover();
  await expect(page.getByRole("tooltip")).toContainText("First thought");
  await expect(page.locator(".note-card-preview")).toHaveCount(0);
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await second.hover();
  await expect(page.getByRole("tooltip")).toContainText("A second formatted thought with code");
  await expect(page.locator(".note-card-preview")).toContainText("First thought");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("tooltip").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.locator(".note-card-preview")).toBeVisible();
  await first.click();
  await expect(page.locator(".note-card-preview")).toHaveCount(0);
  await second.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await second.press("Enter");
  await expect(page.locator(".note-card-preview")).toContainText("A second");
  await page.locator(".note-card-preview").getByRole("button", { name: "Edit note" }).click();
  await expect(page.locator('[contenteditable="true"]')).toContainText("A second formatted thought");
  expect(state.notes).toHaveLength(2);
});

test("note toolbar preserves formatting, saves by button and shortcut, and fits a narrow reader", async ({ page }) => {
  const state = await setup(page);
  await page.locator(".pdf-note-icon").click();
  await page.locator(".note-card-preview").getByRole("button", { name: "Edit note" }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("Compare prefix reuse");
  await editor.selectText();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(state.notes[0].body).toBe("**Compare prefix reuse**");
  await page.locator(".pdf-note-icon").click();
  await page.locator(".note-card-preview").dblclick();
  await expect(editor.locator("strong")).toHaveText("Compare prefix reuse");
  await page.locator('.pdf-scroll').evaluate(node => {
    node.parentElement!.style.width = "320px";
    window.dispatchEvent(new Event('delphi-panel-resize-end'));
  });
  await expect(async () => {
    const card = await page.locator('.note-card-editor').boundingBox();
    const pane = await page.locator('.pdf-scroll').boundingBox();
    const save = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
    expect(card!.x).toBeGreaterThanOrEqual(pane!.x);
    expect(card!.x + card!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
    expect(save!.x + save!.width).toBeLessThanOrEqual(card!.x + card!.width);
  }).toPass();
  await editor.fill("Saved with the displayed shortcut");
  await editor.press("Meta+Enter");
  await expect(editor).toHaveCount(0);
  expect(state.notes[0].body).toBe("**Saved with the displayed shortcut**");
});

test("a growing note stays inside the PDF at the foot of the page", async ({ page }) => {
  await setup(page, 0.94);
  await page.getByRole("button", { name: "Annotations (2)" }).click();
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("A longer thought about the highlighted passage. ".repeat(25));
  await expect(async () => {
    const card = await page.locator('.note-card-editor').boundingBox();
    const paper = await page.locator('.pdf-page').boundingBox();
    expect(card!.y + card!.height).toBeLessThanOrEqual(paper!.y + paper!.height);
  }).toPass();
});

test("PDF fits the settled column after compact and chat panel animations", async ({ page }) => {
  await setup(page);
  const fitError = () => page.locator('.pdf-scroll').evaluate(node => {
    const style = getComputedStyle(node);
    const available = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.abs(node.querySelector('.pdf-page')!.getBoundingClientRect().width - available);
  });
  await expect.poll(fitError).toBeLessThan(2);
  for (const width of [540, 780, 420]) {
    await page.locator('.pdf-scroll').evaluate((node, width) => {
      const panel = node.parentElement!;
      panel.classList.add('three-panel', 'is-panel-animating');
      // Retain the fixture's flex layout; the class is the viewer's real
      // freeze signal during a grid transition in Workspace.
      panel.style.width = `${width}px`;
    }, width);
    await page.waitForTimeout(400);
    await page.locator('.pdf-scroll').evaluate(node => {
      node.parentElement!.classList.remove('is-panel-animating');
      window.dispatchEvent(new Event('delphi-panel-resize-end'));
    });
    await expect.poll(fitError).toBeLessThan(2);
  }
});

test("window resizing previews the PDF without repeatedly rebuilding its canvas", async ({ page }) => {
  await setup(page);
  // Highlights are drawn from their records, before pdf.js has rasterised the
  // page; until then the canvas holds its blank 300px default, and the first
  // raster landing mid-resize would read as a rebuild. The text layer is filled
  // only after the raster completes, so it marks the page as drawn.
  await expect(page.locator('.pdf-page .text-layer')).toContainText('Overlapping strokes');
  const result = await page.locator('.pdf-scroll').evaluate(async node => {
    const host = node.parentElement!;
    const canvas = node.querySelector('canvas')!;
    const before = canvas.width;
    const widths: number[] = [];
    for (let i = 0; i < 18; i++) {
      host.style.width = `${700 - i * 10}px`;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      widths.push(canvas.width);
    }
    return { before, widths };
  });
  expect(result.widths.every(width => width === result.before)).toBe(true);
  await expect.poll(() => page.locator('.pdf-resize-preview').evaluate(el => el.style.transform)).toBe('');
  await expect.poll(() => page.locator('.pdf-page canvas').first().evaluate(el => (el as HTMLCanvasElement).width)).not.toBe(result.before);
});
