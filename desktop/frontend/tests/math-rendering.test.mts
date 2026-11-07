import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLegacyMath } from '../app/lib/remark-latex.ts';
import { remarkDigestMarkdown } from '../app/lib/digest-markdown.ts';
import { render, parse, formulas } from './markdown-test.ts';
import { aligned, shell, matrix, assignments, notation, legacyList, digestList, malformed } from './math-fixture.ts';

test('the stylesheet, title renderer and body renderer share one KaTeX', () => {
  const require = createRequire(import.meta.url);
  const renderer = createRequire(require.resolve('rehype-katex'));
  const version = renderer('katex').version;
  assert.equal(require('katex').version, version);
  assert.ok(readFileSync(require.resolve('katex/dist/katex.css'), 'utf8').includes(`content: "${version}"`));
});

test('reported aligned display is one equation and shell variables remain literal', () => {
  const html = render(aligned);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  assert.equal((html.match(/<mtr>/g) ?? []).length, 2);
  assert.match(render(shell), /PATH=&quot;\$HOME\/\.local\/bin:\$PATH&quot;/);
  assert.equal((render(shell).match(/class="katex"/g) ?? []).length, 1);
});

test('valid math retains its rows, outer environments and multiline boundaries', () => {
  assert.equal((render(matrix).match(/<mtr>/g) ?? []).length, 2);
  for (const source of [aligned, '$\\begin{matrix}\na&b\\\\ c&d\n\\end{matrix}$',
    String.raw`\begin{equation}\begin{aligned}a &= \begin{aligned}b&=c\end{aligned}\end{aligned}\end{equation}`,
    String.raw`\(\begin{matrix}a&b\end{matrix}\)`, 'Assign x=$x_i$ and y=$Y$.',
  ]) {
    assert.doesNotMatch(render(source), /katex-error/);
  }
});

test('Markdown owns nested code, destinations and literal delimiter examples', () => {
  for (const source of ['> ~~~sh\n> \\(literal\\)\n> ~~~', '    \\(literal\\)',
    '- Example\n\n  ~~~sh\n  \\(literal\\)\n  ~~~', '``literal ` \\(x\\)``',
    '[label](https://example.com/\\(literal\\))', '[label][ref]\n\n[ref]: https://example.com/\\(literal\\)',
    '```math\n\\(unfinished fence',
  ]) assert.equal(formulas(source).length, 0, source);
  for (const source of ['```text\nexport PATH="$HOME/.local/bin:$PATH"\n```',
    '````sh\n```math\nx^2\n```\n````', '```math\nx^2',
  ]) assert.equal(formulas(source, [remarkLegacyMath]).length, 0, source);
});

test('display equations preserve list/quote containers and completed streaming text', () => {
  for (const source of ['> Formula \\[x^2\\]\n> After.', '- Formula \\[x^2\\]\n  After.',
    '> - \\[\n>   x^2\n>   \\]\n>   After.',
  ]) {
    const html = render(source);
    assert.doesNotMatch(html, /katex-error/);
    assert.match(html, /^<(blockquote|ul)>[\s\S]*After\.[\s\S]*<\/(blockquote|ul)>$/);
  }
  const prefix = 'A stable **paragraph** with $x_i$.\n\n';
  const stable = parse(prefix).children[0];
  for (let length = 0; length <= aligned.length; length++) assert.deepEqual(parse(prefix + aligned.slice(0, length)).children[0], stable);
});

test('assignment notation remains math, including whitespace and subscripts', () => {
  for (const source of assignments) {
    assert.equal((render(source).match(/<math /g) ?? []).length, 1);
  }
  for (const source of ['export PATH="$HOME/.local/bin:$PATH"', 'LIB=${HOME}/lib:$LIB',
    'export X="$HOME some space $PATH"']) {
    assert.equal((render(source).match(/<math /g) ?? []).length, 0);
  }
});

test('TeX owns enclosed link-like notation, HTML-looking inequalities and indentation', () => {
  for (const source of [...notation, '\\[\nx=1\n\n    + y\n\\]',
    '\\begin{equation}f[x](y) + a<b>c\\end{equation}']) {
    const html = render(source);
    assert.equal((html.match(/<math /g) ?? []).length, 1);
    assert.doesNotMatch(html, /katex-error/);
  }
});

test('TeX delimiters in a paragraph parse exactly as their dollar spelling does', () => {
  // One grammar, not two: the leftmost opener wins and a span never leaves
  // its paragraph, whichever way the delimiter is spelled.
  const dollars = (source: string) => source.replace(/\\[()]/g, () => '$').replace(/\\[[\]]/g, () => '$$');
  for (const source of ['A \\(x_i\\) and \\(a*b*c\\) end.', '*em \\(a<b\\)* and **\\(x[0]\\)**',
    'Soft \\(a\nb\\) break.', '> Quote \\(a\n> b\\) end.', '| a |\n| - |\n| \\(x[i]\\) |',
    'Before \\(unfinished and `\\)` after.', 'Before \\(unfinished [link](https://example.com/\\))',
    'Before \\(unfinished <span title="\\)">', 'Unfinished \\(\n\nMore \\) prose', 'Mid \\[x\n\ny\\] line.',
    '`\\(code\\)` then \\(x\\)']) {
    assert.deepEqual(formulas(source), formulas(dollars(source)), source);
  }
  // Unlike dollars these delimiters have a direction, so a stray one pairs with nothing.
  assert.deepEqual(formulas('Stray \\) then \\(x\\) and \\( open'), ['x']);
});

test('a formula never closes inside code, HTML or a link, so an unfinished one leaves the Markdown as written', () => {
  const plain = (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source));
  for (const source of [malformed, 'Before \\(unfinished and `\\)` after.', 'Before $unfinished and `$` after.',
    'Before \\(unfinished [link](https://example.com/\\)) after.', 'Before \\(unfinished <span title="\\)">',
    '\\[unfinished\n\n```tex\n\\]\n```\n\nAfter.', '$$\nunfinished\n\n~~~tex\n$$\n~~~\n\nAfter.',
    '- \\[unfinished\n\n  More prose.\n\n  `\\]`', '$$\nx = 1\n\nAfter.']) {
    assert.equal(render(source), plain(source), source);
  }
  // Code a formula wholly holds, or that follows its closer, changes nothing.
  for (const source of ['\\(\\text{`a`} + b\\)', '\\(a\\) then `\\)`', '$x$ and `$`',
    '\\begin{aligned}a&=b\\end{aligned} then `\\end{aligned}`']) assert.equal(formulas(source).length, 1, source);
});

test('a dollar run is read whole, as remark-math reads it', () => {
  // A dollar's own construct must not open a break mid-run, or math starts at its second dollar.
  for (const source of ['$$a$ b', 'Cost $$5$ more']) assert.deepEqual(formulas(source), [], source);
});

test('legacy formula fences retain operator signals and list structure', () => {
  for (const expression of ['L = a + b', 'D_{KL}(p||q) = x', 'a^2 + b']) {
    for (const fence of ['```text', '~~~math']) {
      const html = render(`${fence}\r\n${expression}\r\n${fence.slice(0, 3)}`, [remarkLegacyMath]);
      assert.equal((html.match(/<math /g) ?? []).length, 1);
      assert.doesNotMatch(html, /katex-error|<pre>/);
    }
  }
  const html = render(legacyList, [remarkLegacyMath]);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
  assert.equal((html.match(/<math /g) ?? []).length, 1);
  for (const source of ['> ```text\n> a + b\n> ```', '```text\na + b',
    '````md\n```text\na + b\n```\n````']) assert.equal(formulas(source, [remarkLegacyMath]).length, 0, source);
});

test('streamed prefixes retain stable earlier paragraphs and valid source positions', () => {
  const sources = [aligned, ...assignments, ...notation, legacyList,
    'Mid \\[x\n\ny\\] line.', 'Unfinished \\(\n\nMore prose', 'Open \\[\nx = 1\n\n- a\n- b',
    '```python\nx[i]: int\n```', '[label][ref]\n\n[ref]: /target',
    '> - \\[\n>   x^2\n>   \\]\n>   After.'];
  const prefix = 'Stable **paragraph** with $x_i$.\n\n';
  const first = parse(prefix).children[0];
  for (const source of sources) for (let i = 0; i <= source.length; i++) {
    const input = prefix + source.slice(0, i);
    const tree = parse(input);
    assert.deepEqual(tree.children[0], first, input);
    assert.equal(tree.position?.end.offset, input.length);
  }
});

test('digest display conversion preserves lists, quotes, evidence links and following prose', () => {
  const citations = [1, 2].map(id => ({ id, claimType: 'author-claim' as const, page: id, section: null }));
  for (const source of [digestList, '- Item:\n  $$x=1$$ [E1]\n- Next [E2]\n\nTail.',
    '- $$x=1$$ [E1]\n- Next [E2]\n\nTail.',
    '> - Item:\n>   $$x=1$$ [E1]\n> - Next [E2]\n\nTail.',
    '1. Loss:\n   $$\n   x=1\n   $$ [E1]\n2. Next [E2]\n\nTail.']) {
    const html = render(source, [[remarkDigestMarkdown, { citations }]]);
    assert.equal((html.match(/<li>/g) ?? []).length, 2, source);
    assert.equal((html.match(/<math /g) ?? []).length, 1, source);
    assert.equal((html.match(/href="#digest-evidence-/g) ?? []).length, 2, source);
    assert.doesNotMatch(html, /katex-error/);
    assert.match(html, /Tail\.<\/p>$/);
  }
});

test('display boundaries neither add empty paragraphs nor consume adjacent prose', () => {
  assert.doesNotMatch(render('\\[x\\]   '), /<p>/);
  const html = render('Text\n\\[\nx\n\\]\nTail.');
  assert.match(html, /^<p>Text<\/p>/);
  assert.match(html, /<p>Tail\.<\/p>$/);
  assert.equal((html.match(/<math /g) ?? []).length, 1);
});
test('a display opener that starts a line is a block; one that is never closed is not', () => {
  for (const [open, close] of [['\\[', '\\]'], ['$$', '$$'], ['\\begin{equation}', '\\end{equation}']]) {
    for (const source of [`${open}x=1${close}`, `${open}\nx=1\n${close}`, `${open}\nx=1\n\n+ y\n${close}`,
      `- Item\n  ${open}\n  x=1\n  ${close}\n- Next`, `> ${open}\n> x=1\n> ${close}`]) {
      assert.equal(formulas(source).length, 1, source);
      assert.doesNotMatch(render(source), /<p>/, source);
    }
    // Prose after the closer is a paragraph of its own, in every spelling.
    assert.match(render(`${open}x=1${close} [E1] and *more*`), /<\/span><\/span>\n?<p>\[E1\] and <em>more<\/em><\/p>$/);
  }
  // Streaming: until its closer arrives an opener changes nothing after it.
  const list = parse('Open \\[\nx = 1\n\n- a\n- b').children.at(-1);
  assert.equal(list?.type, 'list');
  assert.equal(formulas('\\begin{align}\na &= b').length, 0);
  // A container that ends first closes the block, as it would a fence.
  assert.deepEqual(formulas('> \\[\n> x\n\nAfter \\] the quote.'), ['x']);
  assert.deepEqual(formulas('\uFEFF\\[x\\]'), ['x']);
});

test('only shell variables inside one assignment word are literal', () => {
  for (const [source, count] of [['A="$X:$Y:$Z" then $x$', 1], ['FOO=$BAR and BAZ=$QUX', 1], ['PATH=\\$HOME:$PATH$', 1],
    ['`a="$X:$Y"`', 0], ['cost=$5 and price=$10', 1]] as const) assert.equal(formulas(source).length, count, source);
  // A lone variable a path continues is a path, not an opener.
  assert.deepEqual(formulas('Run export JAVA_HOME=$HOME/jdk then use $x$.'), ['x']);
  assert.deepEqual(formulas('Set PATH=$PATH:/opt/bin, then plot $f(x)$.'), ['f(x)']);
  assert.deepEqual(formulas('Let x=$a/b$ hold.'), ['a/b']);
});
