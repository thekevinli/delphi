import assert from 'node:assert/strict';
import test from 'node:test';
import { remarkDigestMarkdown, digestCodeLocator, repeatsHeaderTitle } from '../app/lib/digest-markdown.ts';
import { render, formulas, parse } from './markdown-test.ts';

const citations = [
  { id: 1, claimType: 'author-claim' as const, page: 4, section: null },
  { id: 2, claimType: 'digest-inference' as const, page: 7, section: null },
  { id: 3, claimType: 'author-claim' as const, page: null, section: 'method' },
];
const plugins = [[remarkDigestMarkdown, { citations }]] as Parameters<typeof render>[1];
const digest = (source: string) => render(source, plugins);

test('legacy equation code becomes math while identifiers and fenced examples stay code', () => {
  assert.deepEqual(formulas('Uses `K`, `z₀ = GEθ(x)`, `Lflow = E[‖ẑ₀ − sg(z₀)‖²₂]` and `ε ~ N(0,I)`.', plugins), [
    'K', 'z_{0} = GEθ(x)', String.raw`Lflow = E[\lVert \hat{z}_{0} - sg(z_{0}) \rVert^{2}_{2}]`, String.raw`ε \sim N(0,I)`,
  ]);
  const source = 'Run `pnpm test` and inspect `gFID`.\n\n```js\nconst σ = `not digest math`;\n```';
  assert.equal(digest(source), render(source));
});

test('grouped evidence retains inference labels, pages and sections', () => {
  const html = digest('Claim [E1] [E1][E2][E3]');
  assert.match(html, /href="#digest-evidence-1-1">\(p\. 4\)<\/a>/);
  assert.match(html, /href="#digest-evidence-2">\(p\. 7 · inference\)<\/a>/);
  assert.match(html, /href="#digest-evidence-3">\(§method\)<\/a>/);
  assert.equal((html.match(/<a /g) ?? []).length, 3);
});

test('legacy evidence definitions remain visible and linked', () => {
  const html = digest('Claim [E1]\n\n[E1]: Word');
  assert.equal((html.match(/href="#digest-evidence-1"/g) ?? []).length, 2);
  assert.match(html, /<\/a>: Word/);
});

test('digest edits preserve literal syntax in nested code, math and destinations', () => {
  for (const source of [
    '~~~md\n`x²` and ![sample](asset:literal)\n\n[E1]\n~~~',
    '> ~~~md\n> `x²` and ![sample](asset:literal) [E1]\n> ~~~',
    '    `x²` and ![sample](asset:literal) [E1]',
    '````md\n```text\n`x²` [E1]\n```\n````',
    'Literal `![sample](asset:literal)` and `[E1]`.',
    '$[E1]$', '$$\n\\text{[E1]}\n$$', '[source](https://example.com/[E1])',
    '<details>\n[E1]\n</details>', '[source]: https://example.com/[E1]',
  ]) assert.equal(digest(source), render(source), source);
});

test('every image embed disappears, titled, remote or by reference; code samples keep theirs', () => {
  // Digest visuals are a structured channel; an image in the prose is a remote hotlink.
  for (const source of ['![plot](https://example.com/plot.png "Caption")', '![plot](https://example.com/plot.png)',
    '![image][ref]\n\n[ref]: https://example.com/image.png "Title"', '![plot](asset:plot "Caption")']) {
    assert.doesNotMatch(digest(source), /<img/, source);
  }
  const source = 'Before.\n\n![alt](asset:plot)\n\nAfter.';
  assert.match(digest(source), /Before\.[\s\S]*After\./);
  const sample = 'Literal `![plot](https://example.com/plot.png)`.';
  assert.equal(digest(sample), render(sample));
});

test('a digest keeps its title unless it repeats the name the header shows above it', () => {
  const opening = (source: string, headerTitle?: string) =>
    parse(source, [[remarkDigestMarkdown, { citations: [], headerTitle }]]).children[0];
  const kept = (source: string, headerTitle?: string) => opening(source, headerTitle)?.type === 'heading';
  // A web page's header names nothing, so its digest's title is the only one.
  assert.ok(kept('# Scaling Laws, Carefully\n\nBody.'));
  // Above a PDF, a title the header's name begins with is the same title.
  assert.ok(!kept('# Test-Time Scaling Makes Overtraining Compute-Optimal\n\nBody.', 'Test-Time Scaling Makes Overtraining Compute-Optimal'));
  assert.ok(!kept('# Why Larger Models Learn More\n\nBody.', 'Why Larger Models Learn More (2605.29548v2)'));
  assert.ok(!kept('# Scaling laws for efficient MoE language models [E1]\n\nBody.', 'Scaling Laws for Efficient MoE Language Models - Ant Group (2507.17702v2)'));
  // Beside its `[E1]: …` line the marker parses as a reference, and is still no part of the title.
  assert.ok(!kept('# Why Larger Models Learn More [E1]\n\nBody.\n\n[E1]: Abstract.', 'Why Larger Models Learn More (2605.29548v2)'));
  // A title that says more than the name, or only starts a word of it, stays.
  assert.ok(kept('# Chinchilla: spend training compute on tokens\n\nBody.', 'Chinchilla (2203.15556v1)'));
  assert.ok(kept('# Scaling\n\nBody.', 'ScalingLaws (2203.15556v1)'));
  // An opening section is never a title, whatever it is called.
  assert.ok(kept('## Core takeaway\n\nBody.', 'Core takeaway'));
  // Only the opening is the title; the same words further down are left alone.
  assert.equal(parse('Introduction.\n\n# Why Larger Models Learn More\n\nBody.', [[remarkDigestMarkdown, { citations: [], headerTitle: 'Why Larger Models Learn More' }]])
    .children.filter(n => n.type === 'heading').length, 1);
});

test('only the opening title is marked as one, and a dropped title passes on nothing', () => {
  const html = (source: string, headerTitle?: string) => render(source, [[remarkDigestMarkdown, { citations: [], headerTitle }]]);
  assert.match(html('# Scaling Laws, Carefully\n\n# Method\n\nBody.'), /^<h1 class="digest-title">Scaling Laws, Carefully<\/h1>\n<h1>Method<\/h1>/);
  // The heading after a title the header already shows is a section, not the next title.
  assert.match(html('# Why Larger Models Learn More\n\n# Summary\n\nBody.', 'Why Larger Models Learn More (2605.29548v2)'), /^<h1>Summary<\/h1>/);
  assert.doesNotMatch(html('## Core takeaway\n\nBody.'), /digest-title/);
});

test('the header comparison ignores emphasis, case and spacing, never words', () => {
  assert.ok(repeatsHeaderTitle('**Why  larger** models learn more', 'Why Larger Models Learn More (2605.29548v2)'));
  assert.ok(!repeatsHeaderTitle('Why larger models learn', 'Why Larger Models Learnt More'));
  assert.ok(!repeatsHeaderTitle('', 'Anything'));
});

test('one-line numbered displays become displays without changing code', () => {
  const html = digest('$$x=1\\tag{1}$$ [E1]');
  assert.match(html, /class="katex-display"/);
  assert.match(html, /href="#digest-evidence-1"/);
  assert.doesNotMatch(html, /katex-error/);
  const code = '```text\n$$x=1$$\n```';
  assert.equal(digest(code), render(code));
});

test('legacy locators are distinguished from code identifiers', () => {
  assert.deepEqual(digestCodeLocator('pp. 1, 7'), { label: '(pp. 1, 7)', page: 1, section: undefined });
  assert.equal(digestCodeLocator('Fig. 8, p. 5')?.page, 5);
  assert.equal(digestCodeLocator('§runtime')?.section, 'runtime');
  for (const code of ['gen(name)', 'p.value', 'page = 4', 's["name"]', 'fork', 'select']) assert.equal(digestCodeLocator(code), null);
});

test('removed embeds leave no empty paragraphs and evidence tails retain formatting', () => {
  assert.equal(digest('Before.\n\n![alt](asset:plot)\n\nAfter.'), '<p>Before.</p>\n<p>After.</p>');
  assert.match(digest('[E1]: **Word**'), /<strong>Word<\/strong>/);
  assert.match(digest('[value `K`](https://example.com)'), /<math /);
  assert.equal((digest('[caption [E1]](https://example.com)').match(/<a /g) ?? []).length, 1);
});

test('adjacent evidence is one chip, never touching code spans', () => {
  const html = render('Supported twice. [E3][E4]', [[remarkDigestMarkdown, { citations: [3, 4].map(id => ({ id, claimType: 'author-claim' as const, page: id === 3 ? 6 : 20, section: null })) }]]);
  assert.match(html, /<a href="#digest-evidence-3-4">\(pp\. 6, 20\)<\/a>/);
  assert.doesNotMatch(html, /`/);
});

test('a dropped embed takes its alt text with it; a fenced one is a code sample', () => {
  // The model writes `![alt](asset:<id>)` beside the figure it declares in `assets`;
  // dropping it here fixes every digest already on disk.
  const html = digest('Alignment is strongest late [E1].\n\n![CKA comparisons between the two pathways](asset:pdf-p7-c0-5d09da0dc61a)\n\nEntropy falls with depth [E2].');
  assert.doesNotMatch(html, /asset:|CKA comparisons/);
  assert.match(html, /Alignment is strongest late[\s\S]*Entropy falls with depth/);
  const fenced = 'Use:\n\n```md\n![alt](https://example.com/a.png)\n```\n\nDone.';
  assert.equal(digest(fenced), render(fenced));
});

test('a display equation inside code or mid-sentence is not promoted', () => {
  const equation = String.raw`$$\frac{x}{y}\tag{1}$$`;
  const literal = `A literal \`${equation}\` remains code.`;
  assert.equal(digest(literal), render(literal));
  const inline = parse(`Inline ${equation} stays inline.`, plugins).children[0];
  assert.equal(inline.type === 'paragraph' && inline.children[1].type, 'inlineMath');
});

test("an outside claim's chip says it is outside, apart from a place in the document", () => {
  const cited = [
    { id: 1, claimType: 'author-claim' as const, page: 3, section: null },
    { id: 2, claimType: 'external' as const, page: null, section: 'limits', evidenceId: 'abc123' },
  ];
  for (const source of ['The paper reports a gain. [E1] A later note qualifies it. [E2]', 'Both. [E1][E2]']) {
    const html = render(source, [[remarkDigestMarkdown, { citations: cited }]]);
    assert.match(html, /<a href="#digest-evidence-1">\(p\. 3\)<\/a>/, source);
    assert.match(html, /<a href="#digest-evidence-2">\(outside source\)<\/a>/, source);
  }
});
