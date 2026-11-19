import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGroup, chatTime, groupChats, newestFirst } from '../app/lib/conversation-layout.ts';

const now = new Date(2026, 10, 14, 15, 0);
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();

test('chats fall under Today, This week or Earlier by local day', () => {
  assert.equal(chatGroup(undefined, now), 'Today');
  assert.equal(chatGroup(at(14, 0), now), 'Today');
  assert.equal(chatGroup(at(13, 23), now), 'This week');
  assert.equal(chatGroup(at(8, 0), now), 'This week');
  assert.equal(chatGroup(at(7, 23), now), 'Earlier');
});

test('a row names its time as briefly as its section allows', () => {
  assert.equal(chatTime(at(14, 13), now), '2h');
  assert.equal(chatTime(at(12), now), new Date(at(12)).toLocaleDateString(undefined, { weekday: 'short' }));
  assert.equal(chatTime(at(1), now), new Date(at(1)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
});

test('the list is newest first, sections in order, and empty sections are left out', () => {
  const chats = [
    { id: 'old', lastEngagedAt: at(1) },
    { id: 'blank' },
    { id: 'week', createdAt: at(10) },
    { id: 'today', lastEngagedAt: at(14, 9) },
  ];
  assert.deepEqual(newestFirst(chats).map(chat => chat.id), ['blank', 'today', 'week', 'old']);
  assert.deepEqual(groupChats(chats, now).map(group => [group.label, group.items.map(chat => chat.id)]), [
    ['Today', ['blank', 'today']],
    ['This week', ['week']],
    ['Earlier', ['old']],
  ]);
  assert.deepEqual(groupChats([{ id: 'x', lastEngagedAt: at(1) }], now).map(group => group.label), ['Earlier']);
});
