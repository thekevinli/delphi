import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../delphi_core/artifacts/inspect.js', import.meta.url), 'utf8');

function fixture(tag, attribute, shape) {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.id = tagName; this.attributes = {}; this.computed = {}; this.pseudo = {}; this.childNodes = []; this.textContent = ''; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return { x: 10, y: 10, width: 200, height: 50, left: 10, top: 10, right: 210, bottom: 60 }; }
    closest(selector) { return this instanceof Input && selector.startsWith('button,input,') ? this : null; }
    matches(selector) {
      if (selector === '[class],[style]') return 'class' in this.attributes || 'style' in this.attributes;
      return this instanceof Input ? selector.startsWith('button,input,') : this.tagName === 'path' && selector.includes('svg path');
    }
  }
  class SVG extends Element {}
  class Input extends Element {}
  class UnusedElement {}
  const path = new SVG(tag);
  path.attributes[attribute] = shape;
  const input = new Input('INPUT');
  input.value = '0';
  const body = new Element('BODY');
  body.innerText = 'Fixture';
  body.childNodes = [{ nodeType: 3, textContent: 'Fixture' }];
  body.scrollWidth = 270; body.scrollHeight = 100;
  const nodes = [body, path, input];
  const context = vm.createContext({
    document: {
      body, documentElement: { clientWidth: 270, clientHeight: 100, scrollWidth: 270, scrollHeight: 100 },
      getAnimations: () => [],
      createTreeWalker() { let index = -1; return { nextNode() { return ++index < nodes.length; }, get currentNode() { return nodes[index]; } }; },
    },
    NodeFilter: { SHOW_ELEMENT: 1 }, Node: { TEXT_NODE: 3 }, CSS: { escape: value => value },
    SVGGraphicsElement: SVG, HTMLInputElement: Input, HTMLSelectElement: UnusedElement,
    HTMLTextAreaElement: UnusedElement, HTMLCanvasElement: UnusedElement, scrollX: 0, scrollY: 0,
    getComputedStyle: (element, pseudo) => ({ display: 'block', visibility: 'visible', overflowX: 'visible', overflowY: 'visible', fontSize: '14px', color: 'black', opacity: '1', ...(pseudo ? { content: 'none', ...element.pseudo[pseudo] } : element.computed) }),
  });
  const inspect = vm.runInContext(`(${source})`, context);
  return { path, input, body, inspect: () => inspect({ kind: 'inspect' }) };
}

for (const [tag, attribute, before, after] of [
  ['path', 'd', 'M10 10H210V60H10Z', 'M10 10L210 60M210 10L10 60'],
  ['polyline', 'points', '10,10 210,10 210,60 10,60', '10,10 210,60 210,10 10,60'],
]) {
  test(`${attribute} changes count as output when SVG bounds and paint stay identical`, () => {
    const item = fixture(tag, attribute, before);
    const initial = item.inspect();
    const bounds = item.path.getBoundingClientRect();
    item.path.attributes[attribute] = after;
    assert.deepEqual(item.path.getBoundingClientRect(), bounds);
    assert.notEqual(item.inspect().effectFingerprint, initial.effectFingerprint);
  });
}

test('a native input value alone changes state but not diagram output', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  const initial = item.inspect();
  item.input.value = '1';
  const changed = item.inspect();
  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(changed.effectFingerprint, initial.effectFingerprint);
});

test('a late path-tail change is observable beyond the general state sample', () => {
  const prefix = 'M10 10 ' + 'L10 10 '.repeat(80);
  const item = fixture('path', 'd', prefix + 'L210 60');
  const initial = item.inspect();
  item.path.attributes.d = prefix + 'L210 10L10 60';
  const changed = item.inspect();
  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.notEqual(changed.effectFingerprint, initial.effectFingerprint);
});

test('a finished animation class does not prevent restoration of the same rendered state', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  item.body.attributes.class = 'story';
  const initial = item.inspect();
  item.body.attributes.class = 'story pop';
  item.body.computed.animationName = 'pop';
  item.body.computed.animationDuration = '0.23s';
  const restored = item.inspect();
  assert.equal(restored.animations, 0);
  assert.equal(restored.fingerprint, initial.fingerprint);
  assert.equal(restored.effectFingerprint, initial.effectFingerprint);
});

test('inert class addition and equivalent inline style spelling are ignored', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  const initial = item.inspect();
  item.body.attributes.class = 'finished';
  item.body.attributes.style = 'color: #000; opacity: 1.0';
  const restored = item.inspect();
  assert.equal(restored.fingerprint, initial.fingerprint);
  assert.equal(restored.effectFingerprint, initial.effectFingerprint);
});

for (const [property, before, after] of [
  ['borderTopColor', 'rgb(0, 0, 0)', 'rgb(120, 20, 40)'],
  ['borderTopWidth', '1px', '3px'],
  ['borderTopStyle', 'solid', 'dashed'],
  ['fontWeight', '400', '700'],
  ['fontSize', '14px', '16px'],
  ['strokeWidth', '2px', '4px'],
  ['strokeDasharray', 'none', '3px, 4px'],
  ['opacity', '1', '0.5'],
  ['transform', 'none', 'matrix(1, 0, 0, 1, 3, 0)'],
]) {
  test(`a real computed ${property} change remains observable with unchanged bounds`, () => {
    const item = fixture('path', 'd', 'M10 10H210V60H10Z');
    item.path.computed[property] = before;
    const initial = item.inspect();
    const bounds = item.path.getBoundingClientRect();
    item.path.computed[property] = after;
    assert.deepEqual(item.path.getBoundingClientRect(), bounds);
    assert.notEqual(item.inspect().effectFingerprint, initial.effectFingerprint);
  });
}

test('a CSS-generated connector change remains observable', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  item.body.pseudo['::after'] = { content: '""', borderTopWidth: '2px', borderTopStyle: 'solid', borderTopColor: 'black' };
  const initial = item.inspect();
  item.body.pseudo['::after'].borderTopColor = 'maroon';
  assert.notEqual(item.inspect().effectFingerprint, initial.effectFingerprint);
});

test('native control focus styles alone are not diagram output', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  const initial = item.inspect();
  item.input.attributes.class = 'focused';
  item.input.computed.borderTopColor = 'maroon';
  item.input.computed.boxShadow = '0px 0px 3px maroon';
  const changed = item.inspect();
  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(changed.effectFingerprint, initial.effectFingerprint);
});

test('a native control restored with an empty class attribute matches its initially absent class', () => {
  const item = fixture('path', 'd', 'M10 10H210V60H10Z');
  assert.equal(item.input.getAttribute('class'), null);
  const initial = item.inspect();
  // classList.add('hidden'), then remove('hidden'), leaves class="" in the DOM.
  item.input.attributes.class = '';
  const restored = item.inspect();
  assert.equal(restored.fingerprint, initial.fingerprint);
  assert.equal(restored.effectFingerprint, initial.effectFingerprint);
});
