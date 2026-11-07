import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFor, sessionCell, adoptSession, disposeSession, conversationStatus, clearConversationSessions} from '../app/lib/conversation-session.ts';
test('streams remain owned by their original session after navigation', () => {
  clearConversationSessions();
  const a = sessionFor('a:0'), b = sessionFor('b:0');
  const controller = new AbortController();
  sessionCell(a, 'controller', controller);
  a.values.set('streaming', true);
  a.values.set('draft', 'first draft'); b.values.set('draft', 'second draft');
  assert.equal(conversationStatus({id:'a',generation:0,title:'A',empty:false}), 'Answering');
  assert.equal(sessionFor('a:0'), a);
  assert.equal(controller.signal.aborted, false);
  disposeSession('a:0');
  assert.equal(controller.signal.aborted, true);
  assert.equal(b.values.get('draft'), 'second draft');
});
test('first-send adoption preserves setters, drafts and stream ownership', () => {
  clearConversationSessions();
  const draft = sessionFor('draft:0');
  draft.values.set('messages', ['question']);
  adoptSession('draft:0', 'saved:0');
  draft.values.set('messages', ['question', 'answer']);
  assert.deepEqual(sessionFor('saved:0').values.get('messages'), ['question', 'answer']);
  assert.notEqual(sessionFor('saved:1'), draft, 'reset generations cannot receive old updates');
});
