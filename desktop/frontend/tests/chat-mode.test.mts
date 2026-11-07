import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatMode, nextChatMode, isModeShortcut } from '../app/lib/chat-mode.ts';
test('Shift+Tab cycles exactly Chat and Plan; unrelated shortcuts retain their behavior', () => {
  assert.equal(nextChatMode(ChatMode.Chat), ChatMode.Plan);
  assert.equal(nextChatMode(ChatMode.Plan), ChatMode.Chat);
  const key = { key: 'Tab', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(isModeShortcut(key), true);
  for (const patch of [{ shiftKey: false }, { key: 'Enter' }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) assert.equal(isModeShortcut({ ...key, ...patch }), false);
});
