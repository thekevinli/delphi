import { test, expect, type Locator } from "@playwright/test";

async function samplePanelTransition(panel: Locator, className: string, variable: string, to: number, selector: string) {
  return panel.evaluate(async (el, { className, variable, to, selector }) => {
    const target = el.querySelector(selector)!;
    // Commit the starting layout before changing the transition's target.
    const before = target.getBoundingClientRect();
    el.classList.add('is-panel-animating', className);
    (el as HTMLElement).style.setProperty(variable, `${to}px`);
    const transition = el.getAnimations().find(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-columns');
    if (!transition) throw new Error('Panel width did not start a grid transition');
    // A timer can run before the first animated frame or after the last one.
    // Sample the real transition at its midpoint, then fully settle it: even
    // rounded target geometry can otherwise leave a transition in flight.
    transition.pause();
    await transition.ready;
    transition.currentTime = Number(transition.effect!.getComputedTiming().activeDuration) / 2;
    const mid = target.getBoundingClientRect();
    transition.finish();
    await transition.finished;
    return {
      before: { x: before.x, right: before.right },
      mid: { x: mid.x, right: mid.right, width: mid.width },
    };
  }, { className, variable, to, selector });
}

// Exercise the shipped stylesheet at the old stacking breakpoints, including
// a long project name and overflowing rail content. No backend data needed.
for (const width of [1512, 1000, 900, 800, 680]) {
  test(`reader keeps its document beside memory at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/tests/browser/harness.html?reader-layout');
    const reader = await page.locator('.reader-panel').boundingBox();
    const rail = await page.locator('.reader-rail').boundingBox();
    expect(reader!.width).toBeGreaterThan(rail!.width);
    expect(rail!.x).toBeGreaterThan(reader!.x + reader!.width);
    // The document card has an 8px top inset; both panes stay in one row.
    expect(Math.abs(rail!.y - reader!.y)).toBeLessThanOrEqual(8);
    expect(rail!.x + rail!.width).toBeLessThanOrEqual(width);
    expect(await page.locator('.reader-project-label').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(30);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600);
    await page.locator('.three-panel').evaluate(el => (el as HTMLElement).style.setProperty('--chat-width', '280px'));
    expect((await page.locator('.reader-panel').boundingBox())!.width).toBeGreaterThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600);
    await page.locator('.three-panel').evaluate(el => {
      el.classList.remove('library-collapsed');
      (el as HTMLElement).style.setProperty('--library-width', '264px');
    });
    const library = await page.locator('.library-panel').boundingBox();
    const openReader = await page.locator('.reader-panel').boundingBox();
    expect(openReader!.x).toBeGreaterThanOrEqual(library!.x + library!.width);
    expect(await page.locator('.library-panel').evaluate(el => getComputedStyle(el).position)).not.toBe('absolute');
    await expect(page.locator('.library-scrim')).toHaveCount(0);
  });
}

test('library toggles move smoothly while ordinary width changes are immediate', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?reader-layout');
  const panel = page.locator('.three-panel');
  await panel.evaluate(el => {
    el.classList.remove('library-collapsed');
    (el as HTMLElement).style.setProperty('--library-width', '264px');
  });
  for (const [from, to] of [[264, 64], [64, 264]]) {
    const { mid } = await samplePanelTransition(panel, 'is-library-animating', '--library-width', to, '.library-panel');
    expect(mid.width).toBeGreaterThan(Math.min(from, to));
    expect(mid.width).toBeLessThan(Math.max(from, to));
    await expect.poll(() => page.locator('.library-panel').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(to);
    await panel.evaluate(el => el.classList.remove('is-panel-animating', 'is-library-animating'));
  }
  const direct = await panel.evaluate(el => {
    (el as HTMLElement).style.setProperty('--library-width', '100px');
    return el.querySelector('.library-panel')!.getBoundingClientRect().width;
  });
  expect(direct).toBe(100);
});

test('chat opening and closing ease the rail leftward without delaying resize gestures', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?reader-layout');
  const panel = page.locator('.three-panel');
  await panel.evaluate(el => (el as HTMLElement).style.setProperty('--chat-width', '280px'));
  for (const [from, to] of [[280, 460], [460, 280]]) {
    const movement = await samplePanelTransition(panel, 'is-chat-animating', '--chat-width', to, '.reader-rail');
    expect(movement.mid.width).toBeGreaterThan(Math.min(from, to));
    expect(movement.mid.width).toBeLessThan(Math.max(from, to));
    expect(Math.abs(movement.mid.right - movement.before.right)).toBeLessThan(1);
    expect(to > from ? movement.mid.x < movement.before.x : movement.mid.x > movement.before.x).toBe(true);
    await expect.poll(() => page.locator('.reader-rail').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(to);
    await panel.evaluate(el => el.classList.remove('is-panel-animating', 'is-chat-animating'));
  }
  for (const resizing of [false, true]) {
    const direct = await panel.evaluate((el, resizing) => {
      el.classList.toggle('is-chat-animating', resizing);
      el.classList.toggle('is-panel-resizing', resizing);
      (el as HTMLElement).style.setProperty('--chat-width', `${resizing ? 350 : 320}px`);
      return el.querySelector('.reader-rail')!.getBoundingClientRect().width;
    }, resizing);
    expect(direct).toBe(resizing ? 350 : 320);
  }
});

// The docked card grows to 79vh, short of pushing Related Memory's heading and
// its first two rows out of the rail. A laptop is held by that floor, and the
// third row is out of view rather than squeezed in under a card that did not
// grow; a tall display reaches the share and shows more. Counted on the real
// list, so a change to the bar, the rail or a row's height shows up here.
for (const [width, height, rows] of [[1512, 800, 2], [1512, 871, 2], [1512, 945, 2], [1728, 1000, 2], [2560, 1440, 4], [2560, 1500, 4]] as const) {
  test(`a ${width}×${height} window keeps ${rows} Related Memory rows under the docked chat`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/tests/browser/harness.html?related-rows');
    await expect(page.locator('.kb-related-list li')).toHaveCount(8);
    const seen = await page.locator('.reader-rail').evaluate((rail, rows) => {
      const { top, bottom } = rail.getBoundingClientRect();
      const heading = rail.querySelector('.kb-related h3')!.getBoundingClientRect();
      const titles = [...rail.querySelectorAll('.kb-related-title')].map(title => title.getBoundingClientRect());
      return {
        card: rail.querySelector('.kb-chat-rail')!.getBoundingClientRect().height,
        heading: heading.top >= top && heading.bottom <= bottom,
        whole: titles.filter(title => title.top >= top && title.bottom <= bottom).length,
        nextHidden: titles[rows].top >= bottom - 1,
      };
    }, rows);
    expect(seen.heading).toBe(true);
    expect(seen.whole).toBe(rows);
    if (rows === 2) expect(seen.nextHidden).toBe(true);
    expect(seen.card).toBeCloseTo(Math.min(0.79 * height, height - 217), 0);
  });
}
