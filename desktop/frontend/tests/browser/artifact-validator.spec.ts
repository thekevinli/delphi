import { expect, test } from "@playwright/test";

const source = `<main><div data-artifact-controls="header"><button type="button" data-artifact-action="back" disabled>Back</button><output data-artifact-progress>Sampling 1 / 4 · t 1.0</output><button type="button" data-artifact-action="next">Next</button></div><h2>A process</h2><output id="step">0</output><div style="height:1000px;background:var(--artifact-cool)">The diagram continues.</div></main><script>
let n=0;const previous=document.querySelector('[data-artifact-action="back"]'),next=document.querySelector('[data-artifact-action="next"]');function draw(){document.querySelector('#step').textContent=n;document.querySelector('[data-artifact-progress]').textContent='Sampling '+(n+1)+' / 4 · t 1.0';previous.disabled=n===0;next.disabled=n===3}previous.onclick=()=>{n--;draw()};next.onclick=()=>{n++;draw()};</script>`;

test("validator mounts the production card at actual chat widths and exercises native header controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  const initial = await page.evaluate(source => window.__delphiArtifactValidator.mount({ title: "A process", source, width: 270 }), source);
  expect(initial.state).toBe("ready");
  expect(initial.frame?.loaded).toBe(true);
  expect(initial.frame?.sandbox).toBe("allow-scripts");
  expect(initial.geometry.figure?.width).toBeCloseTo(270, 0);
  expect(initial.geometry.transcript?.height).toBeLessThanOrEqual(600);
  expect(initial.geometry.headerContained).toBe(true);
  expect(initial.geometry.progressFits).toBe(true);
  expect(initial.geometry.headerOccludesBody).toBe(false);
  expect(initial.geometry.caption?.top).toBeCloseTo(initial.geometry.figure!.top + 1, 0);
  const frame = page.frameLocator("iframe.inline-artifact-frame");
  await expect(frame.locator('[data-artifact-controls="header"]')).toBeHidden();
  await page.evaluate(() => window.__delphiArtifactValidator.action("next"));
  await expect(frame.locator("#step")).toHaveText("1");
  const wide = await page.evaluate(() => window.__delphiArtifactValidator.setWidth(620));
  expect(wide.geometry.figure?.width).toBeCloseTo(620, 0);
  expect(wide.geometry.headerOccludesBody).toBe(false);
  await expect(frame.locator("#step")).toHaveText("1");
  const before = await page.evaluate(() => window.__delphiArtifactValidator.scroll(170));
  const after = await page.evaluate(() => window.__delphiArtifactValidator.scroll(270));
  // The card's own header scrolls away and its docked copy stands at the transcript's top.
  expect(after.geometry.headerVisible).toBe(true);
  expect(before.geometry.docked && after.geometry.docked).toBe(true);
  expect(after.geometry.caption!.top).toBeLessThan(after.geometry.transcript!.top);
  expect(before.geometry.figure!.top - after.geometry.figure!.top).toBeGreaterThan(90);
  await page.evaluate(() => window.__delphiArtifactValidator.action("reset"));
  const checks = await page.evaluate(() => window.__delphiArtifactValidator.probeHeader());
  expect(checks.applicable).toBe(true);
  if (checks.applicable && "next" in checks) {
    expect(checks.next?.controls?.progress).toBe("Sampling 2 / 4 · t 1.0");
    expect(checks.back?.controls?.progress).toBe("Sampling 1 / 4 · t 1.0");
    expect(checks.reset?.controls?.progress).toBe("Sampling 1 / 4 · t 1.0");
  }
});

test("an initial static diagram keeps its heading below the native caption", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  for (const width of [270, 800]) {
    const initial = await page.evaluate(width => window.__delphiArtifactValidator.mount({
      title: "Static diagnostic", width,
      source: '<h2>Two stages</h2><p>Read input, then produce an output.</p><svg viewBox="0 0 220 60"><path d="M20 30H200" stroke="currentColor"/></svg>',
    }), width);
    expect(initial.geometry.scrollTop).toBe(0);
    expect(initial.geometry.headerVisible).toBe(true);
    expect(initial.geometry.headerOccludesBody).toBe(false);
    const geometry = await page.locator(".inline-artifact").evaluate(element => ({
      captionBottom: element.querySelector("figcaption")!.getBoundingClientRect().bottom,
      frameTop: element.querySelector("iframe")!.getBoundingClientRect().top,
    }));
    expect(geometry.captionBottom).toBeLessThanOrEqual(geometry.frameTop + 1);
  }
});

test("validator lifecycle reports author failures and does not expose host actions to the opaque frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  await page.evaluate(() => window.__delphiArtifactValidator.mount({
    title: "Isolation", width: 340,
    source: '<output id="access"></output><script>try{parent.__delphiArtifactValidator.action("reset");document.querySelector("#access").textContent="allowed"}catch{document.querySelector("#access").textContent="blocked"}</script>',
  }));
  await expect(page.frameLocator("iframe.inline-artifact-frame").locator("#access")).toHaveText("blocked");
  const failed = await page.evaluate(() => window.__delphiArtifactValidator.mount({ title: "Failure", width: 340, source: '<script>throw new Error("Author failure")</script>' }));
  expect(failed.state).toBe("error");
  expect(failed.error).toContain("couldn’t run");
});

test("a header sliding into the transcript's top fade docks instead of fading", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  await page.evaluate(source => window.__delphiArtifactValidator.mount({ title: "A process", source, width: 460 }), source);
  for (let top = 4; top <= 64; top += 6) {
    const scrolled = await page.evaluate(top => window.__delphiArtifactValidator.scroll(top), top);
    expect(scrolled.geometry.headerVisible, `header at scroll ${top}`).toBe(true);
    // One title at a time: the card's own header gives way to its docked copy.
    const own = await page.locator(".inline-artifact > figcaption").evaluate(caption => getComputedStyle(caption).opacity);
    expect(own, `own header at scroll ${top}`).toBe(scrolled.geometry.docked ? "0" : "1");
  }
});

test("the docked header spans the card at every chat width and leaves when the card's top returns", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  for (const width of [270, 460, 620, 800]) {
    await page.evaluate(([source, width]) => window.__delphiArtifactValidator.mount({ title: "A process", source, width }), [source, width] as const);
    const scrolled = await page.evaluate(() => window.__delphiArtifactValidator.scroll(260));
    expect(scrolled.geometry.docked, `docked at ${width}`).toBe(true);
    expect(scrolled.geometry.headerVisible).toBe(true);
    const dock = await page.locator(".inline-artifact-dock[data-docked]").evaluate(layer => {
      const box = layer.getBoundingClientRect(), figure = document.querySelector(".inline-artifact")!.getBoundingClientRect();
      const transcript = document.querySelector("[data-validator-transcript]")!.getBoundingClientRect();
      const caption = layer.querySelector(".inline-artifact-caption")!;
      // Every docked control is inside the layer, including a two-row narrow header.
      const inside = [...caption.querySelectorAll("button,.inline-artifact-progress")].every(node => {
        const child = node.getBoundingClientRect();
        return child.height > 0 && child.top >= box.top && child.bottom <= box.bottom && child.left >= box.left && child.right <= box.right;
      });
      return { left: box.left - figure.left, width: box.width - figure.width, top: box.top - transcript.top, fits: caption.scrollWidth <= caption.clientWidth + 1 && inside };
    });
    expect(dock.left).toBeCloseTo(0, 0);
    expect(dock.width).toBeCloseTo(0, 0);
    expect(dock.top).toBeCloseTo(0, 0);
    expect(dock.fits, `docked controls fit at ${width}`).toBe(true);
    const back = await page.evaluate(() => window.__delphiArtifactValidator.scroll(0));
    expect(back.geometry.docked).toBe(false);
    await expect(page.locator(".inline-artifact-dock")).toHaveJSProperty("inert", true);
  }
});

test("the host reports a card title the header cuts off, and a title that fits as whole", async ({ page }) => {
  await page.goto("/tests/browser/artifact-validator.html");
  await page.waitForFunction(() => Boolean(window.__delphiArtifactValidator));
  const card = "<main><p>A figure.</p></main>";
  const mount = (title: string) => page.evaluate(([title, source]) => window.__delphiArtifactValidator.mount({ title, source, width: 460 }), [title, card] as const);
  expect((await mount("Loss curves")).geometry.titleClipped).toBe(false);
  expect((await mount("IsoFLOP curves: loss against model size at nine fixed compute budgets, with each budget's optimal model size marked")).geometry.titleClipped).toBe(true);
});
