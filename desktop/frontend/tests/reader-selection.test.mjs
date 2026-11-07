import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/components/ReaderSelectionMenu.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', output)(require, module, module.exports);
const Menu = module.exports.ReaderSelectionMenu;
const action = () => {};

test('the shared selection toolbar keeps all annotation actions visible while preparing', () => {
  const props = { x: 100, y: 100, onHighlight: action, onNote: action, onReply: action };
  const ready = renderToStaticMarkup(createElement(Menu, props));
  for (const label of ['Highlight', 'Note', 'Reply']) assert.ok(ready.includes(`<span>${label}</span>`));
  assert.equal((ready.match(/<button/g) || []).length, 3);
  assert.ok(!ready.includes('disabled'));
  const pending = renderToStaticMarkup(createElement(Menu, { ...props, preparing: true }));
  assert.equal((pending.match(/<button/g) || []).length, 3);
  assert.equal((pending.match(/disabled=""/g) || []).length, 2);
});

test('a browsed page without persistence still supports Reply', () => {
  const html = renderToStaticMarkup(createElement(Menu, { x: 100, y: 100, onReply: action }));
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<span>Reply<\/span>/);
});
