import assert from 'node:assert/strict';
import test from 'node:test';
import katex from 'katex';
import { titleSegments } from '../app/lib/latex.ts';
import { remarkLegacyMath, repairMath } from '../app/lib/remark-latex.ts';
import { formulas, render } from './markdown-test.ts';

test('valid operators and matrix row breaks survive compatibility repair', () => {
  for (const source of [String.raw`\mathop{\text{argmax}}_{p\in\Delta^{n-1}} p\cdot z+H(p)`,
    String.raw`\operatorname*{argmax}_{x} f(x)`, String.raw`\begin{matrix}a\\xyz\end{matrix}`]) {
    assert.doesNotThrow(() => katex.renderToString(source));
    assert.equal(repairMath(source, true), source);
    assert.equal(repairMath(repairMath(source, true), true), source);
  }
});

test('operator and overescaping repairs apply only inside recognized mathematics', () => {
  assert.equal(formulas(String.raw`$\arg\min_{N,D} L(N,D)$`)[0], String.raw`\operatorname*{arg\,min}_{N,D} L(N,D)`);
  assert.equal(formulas(String.raw`$\argmax_{x} f(x)$`)[0], String.raw`\operatorname*{arg\,max}_{x} f(x)`);
  assert.equal(formulas(String.raw`$\\mathbb{E}_{a \\sim \\pi_{\\theta}}[R(a)]$`)[0], String.raw`\mathbb{E}_{a \sim \pi_{\theta}}[R(a)]`);
  assert.equal(formulas(String.raw`$\text{marg} + 1$`)[0], String.raw`\text{marg} + 1`);
  assert.match(render('the argmin of the loss'), /the argmin of the loss/);
});

test("a title's math is found and its prose left alone", () => {
  const title = String.raw`It uses per-token reverse KL, \(\mathrm{KL}(\pi_\theta\|\pi_{\text{teacher}})\)`;
  const segments = titleSegments(title);
  assert.deepEqual(segments[0], { text: "It uses per-token reverse KL, " });
  assert.equal(segments.length, 2);
  const math = segments[1] as { math: string; source: string };
  assert.equal(math.math, String.raw`\mathrm{KL}(\pi_\theta\|\pi_{\text{teacher}})`);
  assert.doesNotThrow(() => katex.renderToString(math.math, { throwOnError: true }));
  assert.deepEqual(titleSegments("Why $x_t$ drifts"), [
    { text: "Why " }, { math: "x_t", source: "$x_t$" }, { text: " drifts" },
  ]);
});

test("money and unclosed delimiters in a title stay text", () => {
  for (const title of ["$5 vs $10 plans", "Costs $3 and $4_000 later", String.raw`Cut off \(\mathrm{KL}(\pi`, "Plain title"]) {
    assert.deepEqual(titleSegments(title), [{ text: title }]);
  }
});

test("LaTeX's own delimiters are read as the formulas they enclose", () => {
  assert.deepEqual(formulas('the ratio \\(x_i\\) holds'), ['x_i']);
  assert.deepEqual(formulas('\\[ E = mc^2 \\]'), ['E = mc^2']);
  assert.deepEqual(formulas('\\begin{equation}a = b\\end{equation}'), ['a = b']);
  assert.deepEqual(formulas(String.raw`Costs \$5; unmatched $ then \(x_i\).`), ['x_i']);
  for (const source of ["```py\nprint('\\\\(not math\\\\)')\n```", '```text\n$$ [E4]\n```', '    \\(indented\\)\n    $HOME/bin:$PATH', '\t\\(tab indented\\)']) {
    assert.equal(formulas(source).length, 0, source);
  }
  for (const source of ['````text\n``` and \\(not math\\)\n````\nAfter \\(x\\).', '~~~~latex\n\\begin{matrix}a&b\\end{matrix}\n~~~~\nAfter \\(x\\).']) {
    assert.deepEqual(formulas(source), ['x'], source);
  }
});

test('a display carrying its evidence marker leaves the marker and the next section as prose', () => {
  const html = render(String.raw`Before.

$$\mathcal{R}_m=\operatorname{blockdiag}(R(m\theta_0)),\qquad R(\alpha)=\begin{pmatrix}\cos\alpha&-\sin\alpha\\\sin\alpha&\cos\alpha\end{pmatrix}.$$ [E4]

## The next section

After.`);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<p>\[E4\]<\/p>\n<h2>The next section<\/h2>\n<p>After\.<\/p>$/);
});

test('over-escaped commands are repaired in math and left alone in prose', () => {
  const html = render(String.raw`Before \\theta.

$$
\\mathbb{E}_{a \\sim \\pi_{\\theta}}[R(a)]
$$`);
  assert.match(html, /<p>Before \\theta\.<\/p>/);
  assert.deepEqual(formulas(String.raw`$$
\\mathbb{E}_{a \\sim \\pi_{\\theta}}[R(a)]
$$`), [String.raw`\mathbb{E}_{a \sim \pi_{\theta}}[R(a)]`]);
});

test('environments, matrices and multiline inline math each render as one formula', () => {
  for (const source of [
    String.raw`\begin{equation}\begin{aligned}a &= b \\ c &= d\end{aligned}\end{equation}`,
    String.raw`\[R=\begin{pmatrix}a&b\\c&d\end{pmatrix}\]`,
    String.raw`\(\begin{matrix}a&b\end{matrix}\)`,
    String.raw`\begin{aligned}a &= \begin{aligned}b&=c\end{aligned}\\ d&=e\end{aligned}`,
    '$\\begin{matrix}\na&b\\\\ c&d\n\\end{matrix}$', '$x\n+\\frac{a}{b}$', '$$$\\frac{x}{y}$$$',
    String.raw`Keep $\begin{matrix}a&b\end{matrix}$ and ` + '`' + String.raw`\begin{matrix}not math\end{matrix}` + '`.',
  ]) {
    const html = render(source);
    assert.doesNotMatch(html, /katex-error/, source);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 1, source);
  }
});

test('display equations stay inside nested quotes and lists', () => {
  for (const source of [
    '> \\[\n> \\frac{x^2}{y^3}\n> \\]\n>\n> After.',
    '- \\[\n  \\frac{x^2}{y^3}\n  \\]\n\n  After.',
    '> \\begin{aligned}\n> x &= y \\\\\n> z &= w\n> \\end{aligned}',
    '> - Formula \\[x^2\\]\n>   After.',
    '- > Formula \\[x^2\\]\n  > After.',
  ]) {
    const html = render(source);
    assert.doesNotMatch(html, /katex-error/, source);
    assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1, source);
    assert.match(html, /^<(blockquote|ul)>[\s\S]*<\/(blockquote|ul)>$/, source);
    assert.doesNotMatch(html, /<\/(blockquote|ul)>\s*<span/, source);
  }
});

test('shell assignments and code stay literal beside ordinary dollar formulas', () => {
  assert.deepEqual(formulas('Assign x=$x_i$ and y=$Y$.'), ['x_i', 'Y']);
  assert.equal(formulas(String.raw`$\text{PATH} = x$`).length, 1);
  for (const source of ['`export PATH="$HOME/.local/bin:$PATH"`', '```sh\nexport PATH="$HOME/.local/bin:$PATH"\n```', 'Run PATH="`$HOME`" literally.']) {
    assert.equal(formulas(source).length, 0, source);
  }
  for (const assignment of ['PATH=${HOME}/bin:${PATH}', 'PATH=$HOME/bin:$PATH']) {
    const html = render(`Run ${assignment} then $x$.`);
    assert.ok(html.includes(assignment));
    assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  }
});

test('a formula parked in a text fence becomes display math; code and prose stay code', () => {
  // What a real ingest wrote for Tuna-2's Euler update, before the prompt asked for `$…$`.
  const html = render("At inference:\n\n```text\nx_{t'} = x_t + (t' - t) v_theta(x_t, t)\n```\n", [remarkLegacyMath]);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<pre>/);
  for (const source of [
    '```python\nx = f(y)\n```', '```\nconst total = items.reduce((a, b) => a + b, 0);\n```',
    '```mermaid\ngraph TD; A-->B;\n```', '```\nplain prose with no notation at all\n```',
    '```text\nA well-known result\n```', '```\nPATH=$HOME/bin:$PATH\n```', '> ```math\n> x^2\n> ```',
    // Prose, settings and pipelines: italic notation would garble them, and `%` would cut them short.
    '```text\nencoder -> decoder -> head\n```', '```text\nlr = 3e-4, batch = 256\n```',
    '```text\nAccuracy = 92.3% on GSM8K, +4.1 over baseline\n```', '```text\nx = 50%\n```',
    '```text\na <- b\n```', '```text\nf => g\n```', '```text\nx_i grows with depth\n```',
  ]) assert.equal(formulas(source, [remarkLegacyMath]).length, 0, source);
  assert.equal(formulas('```text\nx = 50\\% + y\n```', [remarkLegacyMath]).length, 1);
});
