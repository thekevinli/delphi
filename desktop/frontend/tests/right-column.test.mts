import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { READER_CHAT_CEILING, defaultChatColumn, rightColumnCeiling, rightColumnScale } from '../app/lib/right-column.ts';

test('a laptop keeps its fixed ceiling and a large display widens it', () => {
  // 14" and 16" laptops at their default scaling, and a half-screen window.
  for (const viewport of [960, 1280, 1512, 1728]) assert.equal(rightColumnCeiling(viewport, 700), 700);
  // A 2560px display: about 40% past the laptop's 700.
  const large = rightColumnCeiling(2560, 700);
  assert.ok(large >= 960 && large <= 1000, `${large}`);
  assert.ok(rightColumnCeiling(3008, 700) > large);
  // Every ceiling grows by the same factor.
  assert.equal(rightColumnCeiling(2560, 720), Math.round(720 * rightColumnScale(2560)));
  assert.equal(rightColumnCeiling(1512, 720), 720);
});

test('a dragged column may grow 10% past the old ceiling while it opens where it did', () => {
  assert.equal(READER_CHAT_CEILING, 770);
  for (const viewport of [1512, 1920, 2560, 3440]) {
    const before = Math.max(700, Math.round(viewport * 0.38));
    const ceiling = rightColumnCeiling(viewport, READER_CHAT_CEILING);
    assert.ok(Math.abs(ceiling / before - 1.1) < 0.002, `${viewport}: ${ceiling} vs ${before}`);
    assert.equal(defaultChatColumn(viewport), Math.round(460 * Math.max(1, viewport * 0.38 / 700)));
  }
});

test('the ceiling never falls as the window grows', () => {
  let previous = 0;
  for (let viewport = 800; viewport <= 4000; viewport += 7) {
    const ceiling = rightColumnCeiling(viewport, 700);
    assert.ok(ceiling >= previous && ceiling >= 700);
    previous = ceiling;
  }
});

test('the reader bounds its right column by the shared rule', async () => {
  const reader = await readFile(new URL('../app/components/Workspace.tsx', import.meta.url), 'utf8');
  assert.match(reader, /rightColumnCeiling\(viewport, READER_CHAT_CEILING\)/);
  assert.doesNotMatch(reader, /Math\.min\([^)]*READER_CHAT_CEILING/);
  assert.match(reader, /max=\{sideColumn \? sideColumnCeiling\(maxChatColumn\(viewportWidth\), viewportWidth\) : maxChatColumn\(viewportWidth\)\}/);
});

test('the opening width keeps its proportion to the ceiling', () => {
  for (const viewport of [1280, 1512, 1728]) assert.equal(defaultChatColumn(viewport), 460);
  for (let viewport = 1512; viewport <= 4000; viewport += 11) {
    const ratio = defaultChatColumn(viewport) / rightColumnCeiling(viewport, 700);
    assert.ok(Math.abs(ratio - 460 / 700) < 0.002, `${viewport}: ${ratio}`);
  }
  assert.ok(defaultChatColumn(2560) > 620 && defaultChatColumn(2560) < 660);
  assert.equal(rightColumnScale(1512), 1);
});

test('the reader opens its conversation at the scaled width until it is dragged', async () => {
  const reader = await readFile(new URL('../app/components/Workspace.tsx', import.meta.url), 'utf8');
  assert.match(reader, /chatWidthDragged\.current \? width : [^,]*defaultChatColumn\(window\.innerWidth\)/);
  assert.match(reader, /Math\.min\(336 \* rightColumnScale\(viewport\)/);
});
