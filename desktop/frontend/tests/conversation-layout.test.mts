import test from 'node:test';
import assert from 'node:assert/strict';
import { contextNameFits, visibleConversationCount } from '../app/lib/conversation-layout.ts';

// The strip keeps 32px for its inset and "+", the tab on screen 160px and every other tab 128px.
test('tabs keep a readable width from a narrow rail to an expanded card', () => {
  assert.equal(visibleConversationCount(192, 10), 1);
  assert.equal(visibleConversationCount(319, 10), 1);
  assert.equal(visibleConversationCount(320, 10), 2);
  assert.equal(visibleConversationCount(448, 10), 3);
  assert.equal(visibleConversationCount(1000, 10), 7);
  assert.equal(visibleConversationCount(1344, 10), 10);
});

test('counts stay bounded by the chats open and never drop the one on screen', () => {
  assert.equal(visibleConversationCount(600, 2), 2);
  assert.equal(visibleConversationCount(120, 3), 1);
  assert.equal(visibleConversationCount(0, 0), 0);
  assert.equal(visibleConversationCount(0, 1), 1);
  for (let total = 1; total <= 10; total++) {
    let previous = 1;
    for (let width = 0; width <= 1500; width += 5) {
      const count = visibleConversationCount(width, total);
      assert.ok(count >= previous && count <= total);
      previous = count;
    }
  }
});

test('the context spells out its name only where no tab pays for it', () => {
  // One chat open: the name shows while the tab on screen keeps 160px.
  assert.equal(contextNameFits(450, 52, 1), true);
  assert.equal(contextNameFits(240, 52, 1), false);
  // Two open at 340px of strip: naming would push the second into the list.
  assert.equal(contextNameFits(340, 52, 2), false);
  assert.equal(contextNameFits(390, 52, 2), true);
  // Past the tabs open, the spare room is the name's.
  assert.equal(contextNameFits(700, 52, 3), true);
});
