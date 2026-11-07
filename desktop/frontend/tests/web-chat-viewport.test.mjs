import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Exercise the reader handle ChatPanel calls, without a browser or React mount.
const source = readFileSync(new URL('../app/components/PageViewer.tsx', import.meta.url), 'utf8');
const start = source.indexOf('        getViewport: async (quote = "") => {');
const end = source.indexOf('        openEvidence:', start);
assert.ok(start >= 0 && end > start);
const makeViewport = new Function('historyRef', 'indexRef', 'annotations', 'pinnedReply',
  `return ({${source.slice(start, end)}}).getViewport;`);
const home = { source: 'home', kind: 'html', resolvedUrl: 'https://example.org/article', title: 'Article' };
const viewport = (entry, evidence, pinned = null) => {
  const pinnedReply = { current: pinned };
  const get = makeViewport({ current: [entry] }, { current: 0 }, { evidence }, pinnedReply);
  get.pinned = pinnedReply;
  return get;
};

test('ordinary webpage chat falls back to the stored document when live text is unavailable', async () => {
  const get = viewport(home, async quote => {
    assert.equal(quote, '');
    throw new Error('The page is not ready to read');
  });
  assert.equal(await get(), null);
});

test('a Reply quote still requires its captured evidence', async () => {
  // Reply pins its passage before the question is sent; that pinned passage is
  // strict evidence, so failing to read it fails the question.
  const failure = new Error('Could not read the selected page revision');
  const pinned = { quote: 'Selected passage', url: home.resolvedUrl, title: home.title };
  const get = viewport(home, async quote => {
    assert.equal(quote, 'Selected passage');
    throw failure;
  }, pinned);
  await assert.rejects(get('Selected passage'), error => error === failure);
});

test('a pinned Reply keeps the page it was selected on, even after the reader moved', async () => {
  const capture = { revision: 'b'.repeat(64), texts: ['The pinned passage.'] };
  const pinned = { quote: 'Selected passage', url: 'https://example.org/earlier', title: 'Earlier page' };
  const get = viewport(home, async quote => { assert.equal(quote, 'Selected passage'); return capture; }, pinned);
  assert.deepEqual(await get('Selected passage'), { source: 'captured', kind: 'html', url: pinned.url, title: pinned.title, ...capture });
});

test('available webpage text is included for ordinary chat, and an unpinned quote reads the page', async () => {
  const capture = { revision: 'a'.repeat(64), texts: ['The article as read.'] };
  for (const quote of ['', 'A quote nothing pinned']) {
    const get = viewport(home, async requested => {
      assert.equal(requested, '', 'only a pinned quote narrows the evidence');
      return capture;
    });
    assert.deepEqual(await get(quote), {
      source: 'captured', kind: 'html', url: home.resolvedUrl, title: home.title, ...capture,
    });
  }
});

test('an ordinary question retires the pin, so a later identical quote is not strict', async () => {
  const get = viewport(home, async () => ({ revision: 'c'.repeat(64), texts: [] }),
    { quote: 'Selected passage', url: home.resolvedUrl, title: home.title });
  await get('');
  assert.equal(get.pinned.current, null);
});

test('non-home viewports preserve their existing chat behavior', async () => {
  const unexpected = () => assert.fail('This view does not use the home page index');
  assert.equal(await viewport(undefined, unexpected)(), null);
  assert.equal(await viewport({ ...home, source: 'evidence' }, unexpected)(), null);
  assert.deepEqual(await viewport({ ...home, source: 'anonymous' }, unexpected)(), {
    source: 'anonymous', kind: 'html', url: home.resolvedUrl, title: home.title,
  });
});

test('unavailable chat evidence rejects its request without leaving an annotation error', () => {
  const hook = readFileSync(new URL('../app/lib/use-web-annotations.ts', import.meta.url), 'utf8');
  const begin = hook.indexOf('        if (data.type === "error") {');
  const finish = hook.indexOf('        if (!current.current', begin);
  assert.ok(begin >= 0 && finish > begin);
  const handler = new Function('data', 'pins', 'evidenceRequests', 'pending', 'setError',
    hook.slice(begin, finish).replace('get(data.request)!', 'get(data.request)'));
  const errors = [], rejected = [];
  const requests = { current: new Map([['chat', { reject: reason => rejected.push(reason.message) }]]) };
  const empty = { current: new Map() };
  handler({ type: 'error', request: 'chat', message: 'The page is not ready to read' },
    empty, requests, empty, message => errors.push(message));
  assert.deepEqual(rejected, ['The page is not ready to read']);
  assert.equal(requests.current.size, 0);
  assert.deepEqual(errors, []);
  // Actual index failures must still surface to the reader.
  handler({ type: 'error', message: 'Page text exceeds annotation limits' },
    empty, requests, empty, message => errors.push(message));
  assert.deepEqual(errors, ['Page text exceeds annotation limits']);
});
