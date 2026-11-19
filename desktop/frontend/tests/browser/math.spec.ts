import { test, expect } from '@playwright/test';
import { code, proseFences } from '../math-fixture';

for (const surface of ['chat', 'memory', 'digest']) {
  test(`${surface}: equations, literal code and Markdown survive the rendering pipeline`, async ({ page }, info) => {
    await page.goto(`/tests/browser/harness.html?math&surface=${surface}`);
    await page.evaluate(() => document.fonts.ready);
    const body = page.getByTestId('math-body');
    await expect(body.locator('mtable')).toHaveCount(2);
    await expect(body.locator('mtr')).toHaveCount(4);
    await expect(body).toContainText('PATH="$HOME/.local/bin:$PATH"');
    await expect(body.locator('pre code')).toHaveText(code.split('\n').slice(1, -1).join('\n'));
    await expect(body.locator('math')).toHaveCount(7);
    await expect(body.locator('.math-fallback')).toHaveCount(1); // intentional malformed input
    await body.locator('.math-fallback button').click();
    await expect(body.locator('.math-fallback code')).toHaveText(String.raw`\frac{x}{`);
    await expect(body.locator('p > strong')).toHaveText('Bold');
    await expect(body.locator('em')).toHaveText('italic');
    await expect(body.locator('hr')).toBeVisible();
    await expect(body.locator('blockquote p')).toHaveCount(2);
    await expect(body.locator('ul > li')).toHaveCount(2);
    await expect(body.locator('table')).toHaveCount(1);
    await expect(page.getByTestId('title').locator('.katex')).toHaveCount(1);
    if (surface === 'digest') {
      await expect(body.locator('.katex-html')).toHaveCount(0); // retain native MathML
    } else {
      // Compare with direct KaTeX at equal em scale, independent of typography.
      const referenceHeight = await page.getByTestId('reference').locator('.katex-html').evaluate(n => n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).fontSize));
      const fractionHeight = await body.locator('.katex-display').nth(1).locator('.katex-html').evaluate(n => n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).fontSize));
      expect(fractionHeight).toBeCloseTo(referenceHeight, 1);
      await expect(body.locator('.katex-html .base').first()).toHaveCSS('display', 'inline-block');
    }
    await info.attach(`${surface}-rendering`, { body: await body.screenshot(), contentType: 'image/png' });
    await page.setViewportSize({ width: 600, height: 900 });
    expect(await body.evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  });
}

test('streaming preserves the selected paragraph DOM', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?math&surface=chat');
  const p = page.getByTestId('math-body').locator('p').first();
  await p.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    (window as unknown as { selected: Element }).selected = node;
  });
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  await page.getByRole('button', { name: 'Stream token' }).evaluate(node => (node as HTMLButtonElement).click());
  expect(await p.evaluate(node => node === (window as unknown as { selected: Element }).selected)).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
});

for (const surface of ['chat', 'memory', 'digest']) {
  test(`${surface}: audited assignment math and nested legacy displays`, async ({ page }) => {
    await page.goto(`/tests/browser/harness.html?math&audit&surface=${surface}`);
    const body = page.getByTestId('math-body');
    await expect(body.locator('math')).toHaveCount(surface === 'chat' ? 7 : 8);
    await expect(body.locator('.math-fallback, .katex-error')).toHaveCount(0);
    if (surface !== 'chat') {
      await expect(body.locator('li')).toHaveCount(2);
      await expect(body.locator('li').last()).toContainText('Next');
    }
    if (surface === 'digest') {
      await expect(body.locator('.digest-citation')).toHaveCount(2);
      await expect(body).toContainText('Tail.');
    }
  });
}

test('memory: a fence of settings, results or a pipeline stays code, and only the formula is typeset', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?math&fences&surface=memory');
  const body = page.getByTestId('math-body');
  const lines = [...proseFences.matchAll(/```text\n(.*)\n```/g)].map(match => match[1]);
  await expect(body.locator('pre code')).toHaveText(lines.slice(0, 3));
  await expect(body.locator('math')).toHaveCount(1);
  await expect(body.locator('.katex-error')).toHaveCount(0);
});

for (const surface of ['chat', 'memory', 'digest']) {
  test(`${surface}: a shell path keeps its dollar, and the formula after it is typeset`, async ({ page }) => {
    const source = 'Run export JAVA_HOME=$HOME/jdk then use $x$.';
    await page.goto(`/tests/browser/harness.html?math&surface=${surface}&source=${encodeURIComponent(source)}`);
    const body = page.getByTestId('math-body');
    await expect(body.locator('p')).toContainText('Run export JAVA_HOME=$HOME/jdk then use');
    await expect(body.locator('math')).toHaveCount(1);
    await expect(body.locator('math annotation')).toHaveText('x');
  });
}

for (const surface of ['chat', 'memory', 'digest']) {
  test(`${surface}: an unfinished environment leaves the prose after it as prose and its closer as code`, async ({ page }) => {
    await page.goto(`/tests/browser/harness.html?math&malformed&surface=${surface}`);
    const body = page.getByTestId('math-body');
    await expect(body.getByText(String.raw`\begin{aligned}x &= 1`, { exact: true })).toBeVisible();
    await expect(body.getByText("The prose between stays prose.", { exact: true })).toBeVisible();
    await expect(body.locator('p', { hasText: 'Only' }).locator('code')).toHaveText(String.raw`\end{aligned}`);
    await expect(body.locator('math, .math-fallback, .katex-error')).toHaveCount(0);
  });
}

for (const surface of ['chat', 'memory', 'digest']) {
  test(`${surface}: an unclosed display or a dollar whose closer is code leaves the rest as written`, async ({ page }) => {
    const source = '$$\nx = 1\n\nAfter the display.\n\nBefore $unfinished and `$` after.';
    await page.goto(`/tests/browser/harness.html?math&surface=${surface}&source=${encodeURIComponent(source)}`);
    const body = page.getByTestId('math-body');
    await expect(body.getByText('After the display.', { exact: true })).toBeVisible();
    await expect(body.locator('p', { hasText: 'Before' })).toHaveText('Before $unfinished and $ after.');
    await expect(body.locator('p', { hasText: 'Before' }).locator('code')).toHaveText('$');
    await expect(body.locator('math, .math-fallback, .katex-error')).toHaveCount(0);
  });
}
