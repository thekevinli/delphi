import assert from 'node:assert/strict';
import test from 'node:test';
import { chatModelEfforts, chatEffort, modelLabel } from '../app/lib/chat-model-policy.ts';
import { DEFAULT_APP_CONFIG } from '../app/lib/api.ts';
const backend = {
  'gpt-6-luna': ['xhigh', 'high', 'medium', 'low'],
  'gpt-6.1-sol': ['xhigh', 'high', 'medium', 'low'],
};

test('startup config offers desktop choices within the pinned backend capabilities', () => {
  const config = DEFAULT_APP_CONFIG;
  assert.deepEqual(config.models, ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.equal(config.defaultModel, 'gpt-6.1-sol');
  assert.equal(config.defaultReasoningEffort, 'medium');
  assert.deepEqual(config.models.map(modelLabel), ['GPT-6 Luna', 'GPT-6.1 Sol']);
  assert.deepEqual(config.reasoningEfforts, ['max', 'xhigh', 'high', 'medium', 'low']);
  assert.deepEqual(config.modelReasoningEfforts, {
    'gpt-6-luna': ['max', 'xhigh', 'high', 'medium', 'low'],
    'gpt-6.1-sol': ['max', 'xhigh', 'high', 'medium', 'low'],
  });
  for (const model of config.models) {
    assert.ok((config.modelReasoningEfforts as Record<string, string[]>)[model].includes(config.defaultReasoningEffort));
  }
  assert.equal(chatEffort('gpt-6-luna', 'max', config.modelReasoningEfforts), 'max');
  assert.equal(chatEffort('gpt-6.1-sol', 'max', config.modelReasoningEfforts), 'max');
});

test('chat policy offers each model only the efforts the backend supports', () => {
  assert.deepEqual(chatModelEfforts(backend), {
    'gpt-6-luna': ['xhigh', 'high', 'medium', 'low'], 'gpt-6.1-sol': ['xhigh', 'high', 'medium', 'low'],
  });
  // A max rung appears only once the backend offers it for that model.
  assert.deepEqual(chatModelEfforts({ ...backend, 'gpt-6-luna': ['max', ...backend['gpt-6-luna']] })['gpt-6-luna'], ['max', 'xhigh', 'high', 'medium', 'low']);
  // A model the desktop has no policy for is never offered; one the backend
  // does not serve is never listed.
  assert.deepEqual(chatModelEfforts({ 'gpt-5.6-terra': ['high', 'medium'] }), {});
  // An effort the desktop has no label for is dropped; a narrower backend ladder is kept as is.
  assert.deepEqual(chatModelEfforts({ 'gpt-6-luna': ['max', 'xhigh', 'high', 'medium', 'low', 'ultra'], 'gpt-6.1-sol': ['high', 'medium', 'low'] }),
    { 'gpt-6-luna': ['max', 'xhigh', 'high', 'medium', 'low'], 'gpt-6.1-sol': ['high', 'medium', 'low'] });
  assert.equal(chatEffort('gpt-6-luna', 'max', backend), 'medium');
  assert.equal(chatEffort('gpt-6-luna', 'xhigh', backend), 'xhigh');
  assert.equal(chatEffort('gpt-6.1-sol', 'xhigh', backend), 'xhigh');
  assert.equal(chatEffort('gpt-6.1-sol', 'max', backend), 'medium');
  assert.equal(chatEffort('gpt-6.1-sol', 'low', backend), 'low');
  assert.equal(chatEffort('gpt-6.1-sol', 'high', backend), 'high');
});


test('all Claude models offer the requested ladder and normalize unsupported GPT efforts', () => {
  for (const name of ['Haiku', 'Sonnet', 'Opus']) {
    const model = `claude-${name.toLowerCase()}-5-5`;
    const available = { [model]: ['max', 'xhigh', 'high', 'medium', 'low'] };
    assert.deepEqual(chatModelEfforts(available), { [model]: ['xhigh', 'high', 'medium', 'low'] });
    assert.equal(chatEffort(model, 'max', available), 'medium');
    assert.equal(chatEffort(model, 'xhigh', available), 'xhigh');
    assert.equal(modelLabel(model), `${name} 5.5`);
  }
});
